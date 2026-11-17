// Test doubles implement async interfaces without I/O.
// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createBookingsHandler } from '../handler.ts';
import { createSupabaseBookingsRepository } from '../repository.ts';
import type { Booking, BookingsRepository } from '../repository.ts';

const now = 1793448000;
const token = 'test-only-token';
function signed(id = 42, age = 0) {
    const params = new URLSearchParams({
        user: JSON.stringify({ id, first_name: 'Test' }), auth_date: String(now - age),
    });
    const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1)
        .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
    return params.toString();
}
const statuses = ['Ожидает подтверждения мастера', 'Активна', 'Отменена мастером', 'Отменена моделью'];
function booking(id: number, patch: Partial<Booking> = {}): Booking {
    return {
        booking_id: id, user_id: 42, slot_id: id, status: statuses[id % 4],
        reason: id % 4 === 2 ? 'plans' : null,
        slots: {
            slot_id: id, master_id: 77, service_id: 2, date_time: '2030-01-01T12:00:00Z',
            status: ['Ожидает подтверждения', 'Занят', 'Отменен', 'Свободен'][id % 4],
            city: 'Москва', address: 'Адрес', description: 'Описание',
            services: { service_id: 2, name: 'Услуга' },
        },
        ...patch,
    };
}

// Simulate PostgREST over the real SDK: assert the ownership predicates and join,
// apply them to mixed-owner fixtures and cap each response below the requested limit.
function database(rows: Booking[], cap = 137, failAt = -1) {
    const calls: URL[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        assert.equal(init?.method, 'GET');
        assert.equal(new Headers(init?.headers).get('apikey'), 'server-key');
        assert.equal(url.pathname, '/rest/v1/bookings');
        const p = url.searchParams;
        const master = p.has('slots.master_id');
        const projection = `booking_id,user_id,slot_id,status,reason,slots${master ? '!inner' : ''}(slot_id,date_time,status,master_id,service_id,city,address,description,services(service_id,name))`;
        assert.equal(p.get('select'), projection);
        assert.equal(p.get(master ? 'slots.master_id' : 'user_id'), 'eq.42');
        assert.equal(p.has(master ? 'user_id' : 'slots.master_id'), false);
        if (calls.length === failAt) return Response.json({ message: 'private DB detail' }, { status: 400 });
        let selected = rows.filter((row) => master ? row.slots?.master_id === 42 : row.user_id === 42);
        const filter = p.get('booking_id');
        if (filter) {
            const [op, id] = filter.split('.');
            assert.ok(['eq', 'lt'].includes(op));
            selected = selected.filter((row) => op === 'eq' ? row.booking_id === Number(id) : row.booking_id < Number(id));
        }
        if (p.has('order')) assert.equal(p.get('order'), 'booking_id.desc');
        selected = selected.sort((a, b) => b.booking_id - a.booking_id);
        return Response.json(selected.slice(0, Math.min(Number(p.get('limit') || cap), cap)));
    };
    return { calls, repository: createSupabaseBookingsRepository('https://example.test', 'server-key', fetchImpl) };
}
function server(repository: BookingsRepository, envPatch: Record<string, string | undefined> = {}) {
    let creations = 0;
    const handler = createBookingsHandler({
        env: (key) => ({ BOT_TOKEN: token, SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'server-key', ...envPatch })[key],
        nowSeconds: () => now,
        createRepository: () => { creations++; return repository; },
    });
    const request = (body: unknown, options: RequestInit = {}) => handler(new Request('https://example.test/bookings-read', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
    }));
    return { handler, request, get creations() { return creations; } };
}

const source = await readFile(new URL('../../../../webapp/js/data/bookings.js', import.meta.url), 'utf8');
const code = source.replace(/^import .*;\n/gm, '')
    .replace('const readClient =', `const APP_CONFIG = {supabase: {url: 'https://example.test', key: 'public-key'}};
const getTelegramInitData = () => 'signed';
const supabase = {from() {throw Error('Forbidden browser table access');}};
const sendNotification = () => {throw Error('Unexpected mutation');};
const readClient =`);
const { createBookingsReadClient } = await import('data:text/javascript;base64,' + btoa(String.fromCharCode(...new TextEncoder().encode(code))));

function browser(handler: (req: Request) => Promise<Response>) {
    return createBookingsReadClient({
        url: 'https://example.test', key: 'public-key', getInitData: () => signed(),
        fetchImpl: (url: string, options: RequestInit) => {
            assert.equal(url, 'https://example.test/functions/v1/bookings-read');
            assert.equal(options.cache, 'no-store');
            assert.equal(options.redirect, 'error');
            assert.equal(options.credentials, 'omit');
            assert.equal(new Headers(options.headers).get('apikey'), 'public-key');
            const body = JSON.parse(String(options.body));
            assert.ok(Object.keys(body).every((k) => ['action', 'init_data', 'booking_id', 'before'].includes(k)));
            return handler(new Request(url, options));
        },
    });
}

test('browser → handler → real SDK: owned model/master lists preserve all statuses, service data, archive and descending order beyond 1000', async () => {
    for (const cap of [1000, 137, 1]) {
        const count = cap === 1 ? 25 : 1607;
        const own = Array.from({ length: count }, (_, i) => booking(i + 1));
        const master = own.map((row) => ({ ...row, booking_id: row.booking_id + count, user_id: 999, slots: { ...row.slots!, master_id: 42 } }));
        const db = database([...own, ...master, booking(99999, { user_id: 999 })], cap);
        const client = browser(server(db.repository).handler);
        assert.deepEqual(await client.getUserBookings(999), own.reverse());
        assert.deepEqual(await client.getMasterBookings(999), master.reverse());
        assert.ok(db.calls.length > 4);
    }
});

test('single records: model and slot owner see only their bookings; foreign/missing share null; nullable historical joins retained', async () => {
    const model = booking(1), master = booking(2, { user_id: 999, slots: { ...booking(2).slots!, master_id: 42 } });
    const orphan = booking(3, { slots: null, slot_id: null });
    const foreign = booking(4, { user_id: 999 });
    const client = browser(server(database([model, master, orphan, foreign]).repository).handler);
    assert.deepEqual(await client.getBooking('1'), model);
    assert.deepEqual(await client.getBooking(2), master);
    assert.deepEqual(await client.getBooking(3), orphan);
    assert.equal(await client.getBooking(4), null);
    assert.equal(await client.getBooking(98765), null);
});

test('keyset pagination survives deletion of a previously read row and insertion ahead of cursor', async () => {
    const rows = [booking(1), booking(2), booking(3)];
    const db = database(rows, 2);
    assert.deepEqual((await db.repository.getPage(42, 'user', null)).map((b) => b.booking_id), [3, 2]);
    rows.splice(2, 1);
    rows.push(booking(4));
    assert.deepEqual((await db.repository.getPage(42, 'user', 2)).map((b) => b.booking_id), [1]);
});

test('missing, forged, expired, future and malformed authorization never creates privileged repository', async () => {
    for (const init_data of [undefined, '', 'broken', signed().replace('Test', 'Fake'), signed(42, 86401), signed(42, -1), signed() + '&user=x']) {
        const f = server(database([]).repository);
        assert.equal((await f.request({ action: 'user', init_data })).status, 401);
        assert.equal(f.creations, 0);
    }
});

test('actor spoofing and malformed IDs/cursors rejected before repository creation', async () => {
    for (const action of ['booking', 'user', 'master']) {
        for (const field of ['user_id', 'master_id', 'userId', 'masterId', 'filters', 'initDataUnsafe']) {
            const f = server(database([]).repository);
            assert.equal((await f.request({ action, init_data: signed(), ...(action === 'booking' ? { booking_id: 1 } : {}), [field]: 999 })).status, 400);
            assert.equal(f.creations, 0);
        }
    }
    for (const id of [0, -1, 1.5, {}, true, '1 OR 1=1', Number.MAX_SAFE_INTEGER + 1]) {
        for (const action of ['booking', 'user', 'master']) {
            const f = server(database([]).repository);
            assert.equal((await f.request({ action, init_data: signed(), [action === 'booking' ? 'booking_id' : 'before']: id })).status, 400);
            assert.equal(f.creations, 0);
        }
    }
    const f = server(database([]).repository);
    assert.equal((await f.handler(new Request('https://example.test/?user_id=999', { method: 'POST' }))).status, 400);
});

test('response allowlist strips private booking, slot and service fields; ownership checked again', async () => {
    const row = booking(1);
    const extra = { ...row, phone_number: 'secret', users: { name: 'secret' }, slots: {
        ...row.slots!, private: 'secret', services: { ...row.slots!.services!, private: 'secret' },
    } };
    const repository: BookingsRepository = { getBooking: async () => extra, getPage: async () => [extra] };
    const f = server(repository);
    const response = await f.request({ action: 'booking', booking_id: 1, init_data: signed() });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { booking: row });
    assert.deepEqual(await (await f.request({ action: 'user', init_data: signed() })).json(), { bookings: [row], next_cursor: 1 });
    for (const action of ['booking', 'master', 'user']) {
        const res = await f.request({ action, ...(action === 'booking' ? { booking_id: 1 } : {}), init_data: signed(888) });
        assert.equal(res.status, 500);
        assert.doesNotMatch(await res.text(), /secret|booking_id/);
    }
});

test('later-page database failure yields safe API error and no partial client list/fallback', async () => {
    for (const role of ['user', 'master'] as const) {
        const rows = [booking(1), booking(2), booking(3)].map((row) => role === 'master' ? { ...row, slots: { ...row.slots!, master_id: 42 } } : row);
        const db = database(rows, 2, 2);
        const f = server(db.repository);
        const client = browser(f.handler);
        await assert.rejects(role === 'user' ? client.getUserBookings(42) : client.getMasterBookings(42), (e: Error) => !/private|secret/.test(e.message));
        assert.equal(db.calls.length, 2);
    }
});

test('empty lists and missing records stay compatible', async () => {
    const client = browser(server(database([]).repository).handler);
    assert.deepEqual(await client.getUserBookings(42), []);
    assert.deepEqual(await client.getMasterBookings(42), []);
    assert.equal(await client.getBooking(1), null);
});

test('HTTP, body limits, methods, CORS and configuration errors fail closed', async () => {
    const f = server(database([]).repository);
    assert.equal((await f.handler(new Request('https://example.test'))).status, 405);
    assert.equal((await f.handler(new Request('https://example.test', { method: 'OPTIONS' }))).status, 200);
    assert.equal((await f.request({}, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await f.request({}, { body: '{broken' })).status, 400);
    assert.equal((await f.request({ init_data: 'x'.repeat(17000) })).status, 413);
    for (const patch of [{ BOT_TOKEN: '' }, { SUPABASE_URL: '' }, { SUPABASE_SERVICE_ROLE_KEY: '' }, { SUPABASE_SECRET_KEYS: '{bad' }]) {
        const s = server(database([]).repository, patch);
        assert.equal((await s.request({ action: 'user', init_data: signed() })).status, 503);
        assert.equal(s.creations, 0);
    }
});

test('client rejects transport, malformed JSON, authorization, invalid pages, repeated cursors and wrong single IDs without fallback', async () => {
    for (const mode of ['network', 'json', '401', '500', 'shape', 'cursor', 'order', 'single', 'null']) {
        let calls = 0;
        const client = createBookingsReadClient({ url: '', key: '', getInitData: () => 'signed', fetchImpl: async () => {
            calls++;
            if (mode === 'network') throw Error('private transport');
            if (mode === 'json') return new Response('private gateway');
            if (mode === '401' || mode === '500') return Response.json({ error: { message: 'private detail' } }, { status: Number(mode) });
            if (mode === 'single') return Response.json({ booking: booking(99) });
            if (mode === 'null') return Response.json(null);
            if (mode === 'shape') return Response.json({ bookings: [{}], next_cursor: null });
            if (mode === 'order') return Response.json({ bookings: [booking(1), booking(2)], next_cursor: 2 });
            return Response.json({ bookings: [booking(2)], next_cursor: 2 });
        } });
        await assert.rejects(mode === 'single' ? client.getBooking(1) : client.getUserBookings(42), (e: Error) => !/private/.test(e.message));
        assert.equal(calls, mode === 'cursor' ? 2 : 1);
    }
    const client = createBookingsReadClient({ url: '', key: '', getInitData: () => '', fetchImpl: () => { throw Error('must not fetch'); } });
    await assert.rejects(client.getMasterBookings(99), { code: 'UNAUTHORIZED' });
});

test('existing record card renders model/master pending, active and archive API objects', async () => {
    const source = await readFile(new URL('../../../../webapp/js/components/record-card.js', import.meta.url), 'utf8');
    const module = await import('data:text/javascript;base64,' + btoa(String.fromCharCode(...new TextEncoder().encode(
        source.replace(/^import .*;\n/gm, 'const hapticImpact = () => {};\n'),
    ))));
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    function element() {
        const children: unknown[] = [];
        return { children, innerHTML: '', textContent: '', className: '', type: '',
            appendChild(child: unknown) { children.push(child); },
            querySelector() { return { appendChild(child: unknown) { children.push(child); } }; },
            addEventListener() {},
        };
    }
    Object.defineProperty(globalThis, 'document', { value: { createElement: element }, configurable: true });
    try {
        const client = browser(server(database([booking(1), booking(2), booking(3), booking(4)]).repository).handler);
        const rows: Booking[] = await client.getUserBookings(999);
        const active = rows.filter((r) => ['Активна', 'Ожидает подтверждения мастера'].includes(r.status!));
        const archive = rows.filter((r) => !active.includes(r));
        assert.equal(active.length, 2);
        assert.equal(archive.length, 2);
        for (const record of rows) {
            for (const role of ['model', 'master']) {
                const card = module.createRecordCard({ record, role });
                for (const text of ['Услуга', 'Москва', 'Адрес', 'Описание', record.status]) {
                    assert.ok(card.innerHTML.includes(text));
                }
            }
        }
        const card = module.createRecordCard({ record: booking(1), role: 'model', onContact() {}, onCancel() {} });
        assert.equal(card.children.length, 2);
        const pending = module.createRecordCard({ record: booking(4), role: 'master', onApprove() {}, onReject() {} });
        assert.equal(pending.children.length, 2);
    } finally {
        if (original) Object.defineProperty(globalThis, 'document', original);
        else Reflect.deleteProperty(globalThis, 'document');
    }
});

test('endpoint configuration and read helpers contain no browser table fallback; mutations retain their separate boundary', async () => {
    const config = await readFile(new URL('../../../config.toml', import.meta.url), 'utf8');
    assert.match(config, /\[functions.bookings-read\]\s*verify_jwt\s*=\s*false/);
    const reads = source.slice(0, source.indexOf('export async function confirmBooking'));
    assert.doesNotMatch(reads, /\.from\(|\.rpc\(/);
    assert.match(reads, /await getSlot\(booking.booking_id\)/);
    const search = await readFile(new URL('../../../../webapp/js/screens/model/search.js', import.meta.url), 'utf8');
    assert.match(search, /fillSuccessScreen\(\s*booking\?\.slot \|\|\s*slot\s*\)/);
});
