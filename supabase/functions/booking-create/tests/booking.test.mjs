import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createBookingHandler } from '../handler.ts';

// No network, credentials, SDK installation, or browser globals are needed.
const browser = { initData: '', notifications: [], reads: 0, failRead: false, failNotify: false };
const moduleSource = {
    '@supabase/supabase-js': 'export const createClient = (...args) => globalThis.__bb11Client(...args);',
    'supabase.js': `export const supabase = { from() { throw Error('Forbidden browser table access'); } };`,
    'notifications.js': `export async function sendNotification(...args) {
        globalThis.__bb11Browser.notifications.push(args);
        if (globalThis.__bb11Browser.failNotify) throw Error('private notification failure');
    }`,
    'config.js': "export const APP_CONFIG = {supabase: {url: 'https://example.invalid', key: 'public-key'}};",
    'telegram.js': 'export const getTelegramInitData = () => globalThis.__bb11Browser.initData;',
};
globalThis.__bb11Browser = browser;
registerHooks({
    resolve(specifier, context, nextResolve) {
        const key = specifier === '@supabase/supabase-js'
            ? specifier
            : context.parentURL?.endsWith('/webapp/js/data/bookings.js')
            ? specifier.split('/').at(-1) : '';
        if (Object.hasOwn(moduleSource, key)) {
            return { url: `data:text/javascript,${encodeURIComponent(moduleSource[key])}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
const { createSupabaseBookingRepository } = await import('../repository.ts');
const { createBooking } = await import('../../../../webapp/js/data/bookings.js');

const now = 1800000000;
const token = 'local-test-token';
function signed({ id = 42, authDate = now, firstName = 'Test' } = {}) {
    const params = new URLSearchParams({
        auth_date: String(authDate), user: JSON.stringify({ id, first_name: firstName }),
    });
    const check = [...params].sort(([a], [b]) => a < b ? -1 : 1)
        .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
}
const booking = { booking_id: 11, user_id: 42, slot_id: 7, status: 'Ожидает подтверждения мастера', reason: null };
function setup({ result = { booking, replayed: false }, error, envPatch = {} } = {}) {
    const calls = [];
    let creations = 0;
    const env = { BOT_TOKEN: token, SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'server-only', ...envPatch };
    const handler = createBookingHandler({
        env: (name) => env[name], nowSeconds: () => now,
        createRepository(url, key) {
            creations++;
            assert.equal(url, env.SUPABASE_URL);
            assert.equal(key, 'server-only');
            return { async book(...args) { calls.push(args); if (error) throw error; return result; } };
        },
    });
    const request = (body = { slot_id: 7, init_data: signed() }, options = {}) => handler(new Request(
        'https://example.invalid/booking-create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), ...options,
        },
    ));
    return { handler, request, calls, creations: () => creations };
}

test('valid Telegram auth invokes one RPC with verified identity and returns compatible booking', async () => {
    const s = setup({ result: { booking: { ...booking, private_field: 'secret' }, replayed: false } });
    const response = await s.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { booking, replayed: false });
    assert.deepEqual(s.calls, [[42, 7]]);
});

test('invalid, expired, future, duplicate, and tampered signed auth never access server data', async () => {
    const valid = signed();
    const spoofed = new URLSearchParams(valid);
    spoofed.set('user', JSON.stringify({ id: 999, first_name: 'Test' }));
    for (const initData of [undefined, null, {}, '', 'bad', valid.replace('Test', 'Other'),
        spoofed.toString(),
        signed({ authDate: now - 86401 }), signed({ authDate: now + 1 }),
        `${valid}&auth_date=${now}`, signed({ id: 0 }), signed({ id: 1.5 })]) {
        const s = setup();
        assert.equal((await s.request({ slot_id: 7, init_data: initData })).status, 401);
        assert.equal(s.creations(), 0);
        assert.deepEqual(s.calls, []);
    }
});

test('actor spoofing through extra fields or query is rejected', async () => {
    for (const key of ['user_id', 'actor_id', 'model_id', 'master_id', 'p_user_id', 'replayed']) {
        const s = setup();
        assert.equal((await s.request({ init_data: signed(), slot_id: 7, [key]: 999 })).status, 400);
        assert.equal(s.creations(), 0);
    }
    const s = setup();
    assert.equal((await s.handler(new Request('https://example.invalid/?user_id=999', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ init_data: signed(), slot_id: 7 }),
    }))).status, 400);
});

test('invalid slot IDs are rejected without RPC', async () => {
    for (const slotId of [null, 0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, {}, true]) {
        const s = setup();
        assert.equal((await s.request({ slot_id: slotId, init_data: signed() })).status, 422);
        assert.deepEqual(s.calls, []);
    }
});

test('documented BB-24 failures have safe public status/code; private errors stay private', async () => {
    for (const [dbCode, message, status, code] of [
        ['PT404', 'BB24_USER_NOT_FOUND', 404, 'PROFILE_NOT_FOUND'],
        ['PT404', 'BB24_SLOT_NOT_FOUND', 404, 'SLOT_NOT_FOUND'],
        ['PT409', 'BB24_SLOT_UNAVAILABLE', 409, 'SLOT_UNAVAILABLE'],
        ['PT409', 'BB24_SLOT_EXPIRED', 409, 'SLOT_EXPIRED'],
        ['PT409', 'BB24_INVALID_STATE', 409, 'SLOT_UNAVAILABLE'],
        ['PT403', 'BB24_MODEL_REJECTED', 403, 'BOOKING_FORBIDDEN'],
        ['PT422', 'BB24_INVALID_ARGUMENT', 422, 'INVALID_SLOT'],
        ['23505', 'private database error', 500, 'BOOKING_UNAVAILABLE'],
        ['PT409', 'private database error', 500, 'BOOKING_UNAVAILABLE'],
    ]) {
        const s = setup({ error: { code: dbCode, message, details: 'private database details' } });
        const response = await s.request();
        assert.equal(response.status, status);
        const body = await response.json();
        assert.equal(body.error.code, code);
        assert.doesNotMatch(JSON.stringify(body), /private|BB24|server-only/);
        assert.equal(s.calls.length, 1);
    }
});

test('replay, including confirmed booking, is returned unchanged without another write path', async () => {
    const active = { ...booking, status: 'Активна' };
    const s = setup({ result: { booking: active, replayed: true } });
    assert.deepEqual(await (await s.request()).json(), { booking: active, replayed: true });
    assert.equal(s.calls.length, 1);
});

test('foreign or malformed RPC result is never exposed', async () => {
    for (const result of [null, {}, { booking, replayed: 'false' },
        { booking: { ...booking, user_id: 999 }, replayed: true },
        { booking: { ...booking, slot_id: 8 }, replayed: true }]) {
        const response = await setup({ result }).request();
        assert.equal(response.status, 500);
        assert.doesNotMatch(await response.text(), /999|booking_id|server-only/);
    }
});

test('HTTP validation, CORS, payload bounds and missing server config', async () => {
    const s = setup();
    assert.equal((await s.handler(new Request('https://example.invalid', { method: 'OPTIONS' }))).status, 200);
    assert.equal((await s.handler(new Request('https://example.invalid'))).status, 405);
    assert.equal((await s.request({}, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await s.request({}, { body: '{broken' })).status, 400);
    assert.equal((await s.request({ init_data: 'x'.repeat(17000) })).status, 413);
    assert.equal((await setup({ envPatch: { BOT_TOKEN: '' } }).request()).status, 503);
    assert.equal((await setup({ envPatch: { SUPABASE_SECRET_KEYS: '{bad' } }).request()).status, 503);
    assert.equal((await setup({ envPatch: { SUPABASE_SERVICE_ROLE_KEY: '' } }).request()).status, 503);
});

test('server repository calls only bb24_book_slot once and propagates RPC failure', async () => {
    let rpcError;
    const calls = [];
    globalThis.__bb11Client = (url, key, options) => {
        assert.equal(key, 'server-only');
        assert.equal(options.auth.persistSession, false);
        assert.equal(options.auth.autoRefreshToken, false);
        return { async rpc(...args) { calls.push(args); return { data: { booking, replayed: false }, error: rpcError }; } };
    };
    const repository = createSupabaseBookingRepository('https://example.invalid', 'server-only');
    assert.deepEqual(await repository.book(42, 7), { booking, replayed: false });
    rpcError = { code: 'XX000', message: 'db failure' };
    await assert.rejects(repository.book(42, 7), (error) => error === rpcError);
    assert.deepEqual(calls, Array(2).fill(['bb24_book_slot', { p_user_id: 42, p_slot_id: 7 }]));
});

function resetBrowser() {
    browser.initData = signed();
    browser.notifications = [];
    browser.reads = 0;
    browser.failRead = false;
    browser.failNotify = false;
}

test('browser → handler → mocked RPC: retry has same booking, no second record or notification', async () => {
    resetBrowser();
    const originalFetch = globalThis.fetch;
    let rows = 0;
    let rpcCalls = 0;
    const handler = createBookingHandler({
        env: (name) => ({ BOT_TOKEN: token, SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'server-only' })[name],
        nowSeconds: () => now,
        createRepository: () => ({ async book(userId, slotId) {
            assert.deepEqual([userId, slotId], [42, 7]);
            rpcCalls++;
            // Mock BB-24's live-booking replay contract, not its SQL implementation.
            const replayed = rows > 0;
            rows = 1;
            return { booking, replayed };
        } }),
    });
    globalThis.fetch = (url, options) => {
        if (url === 'https://example.invalid/functions/v1/bookings-read') {
            browser.reads++;
            assert.deepEqual(JSON.parse(options.body), { action: 'booking', booking_id: 11, init_data: signed() });
            return Promise.resolve(Response.json({ booking: { ...booking, slots: {
                slot_id: 7, date_time: '2030-01-01', services: { name: 'Test' },
            } } }));
        }
        assert.equal(url, 'https://example.invalid/functions/v1/booking-create');
        assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['init_data', 'slot_id']);
        assert.equal(options.headers.apikey, 'public-key');
        return handler(new Request(url, options));
    };
    try {
        const first = await createBooking(999, 7);
        const replay = await createBooking(123, 7);
        assert.deepEqual(first, replay);
        assert.equal(first.user_id, 42);
        assert.equal(first.slot.services.name, 'Test');
        assert.equal(browser.reads, 2);
        assert.equal(rows, 1);
        assert.equal(rpcCalls, 2);
        assert.deepEqual(browser.notifications, [['notify-master', { type: 'booking_created', booking_id: 11 }]]);
    } finally { globalThis.fetch = originalFetch; }
});

test('notification failure and display read failure cannot turn saved booking into rejection', async () => {
    resetBrowser();
    browser.failNotify = true;
    browser.failRead = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (url.endsWith('/bookings-read')) throw Error('private read failure');
        return Response.json({ booking, replayed: false });
    };
    try {
        assert.deepEqual(await createBooking(999, 7), { ...booking, slot: null });
        assert.equal(browser.notifications.length, 1);
    } finally { globalThis.fetch = originalFetch; }
});

test('browser RPC rejection/transport failure has no table fallback, enrichment, or notification', async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const mode of ['rpc', 'network', 'json', 'auth']) {
            resetBrowser();
            let calls = 0;
            if (mode === 'auth') browser.initData = '';
            globalThis.fetch = async () => {
                calls++;
                if (mode === 'network') throw Error('private transport error');
                if (mode === 'json') return new Response('private gateway error', { status: 502 });
                return Response.json({ error: { code: 'SLOT_UNAVAILABLE', message: 'private db error' } }, { status: 409 });
            };
            await assert.rejects(createBooking(42, 7), (error) => !/private/.test(error.message));
            assert.equal(calls, mode === 'auth' ? 0 : 1);
            assert.equal(browser.reads, 0);
            assert.equal(browser.notifications.length, 0);
        }
    } finally { globalThis.fetch = originalFetch; }
});

test('config registers Telegram auth endpoint; createBooking contains no direct writes', async () => {
    const config = await readFile(new URL('../../../config.toml', import.meta.url), 'utf8');
    assert.match(config, /\[functions.booking-create\]\s*verify_jwt\s*=\s*false/);
    const source = await readFile(new URL('../../../../webapp/js/data/bookings.js', import.meta.url), 'utf8');
    const create = source.slice(source.indexOf('export async function createBooking'), source.indexOf('export async function getUserBookings'));
    assert.doesNotMatch(create, /\.insert\(|\.update\(|\.rpc\(/);
});
