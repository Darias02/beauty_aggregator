// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlotsWriteHandler } from '../handler.ts';
import type { SlotsWriteRepository } from '../repository.ts';
import { actor, botToken, now, signInitData } from '../../user-profile/tests/helpers.ts';

const input = { service_id: 301, date_time: '2030-01-01T12:00:00.000Z', city: 'Москва', address: '', description: '' };
function fixture(error?: unknown, config: Record<string, string | undefined> = {}) {
    const calls: unknown[][] = [];
    let creations = 0;
    const repository: SlotsWriteRepository = {
        async create(id, fields) {
            calls.push(['create', id, fields]);
            if (error) throw error;
            return { ...fields, slot_id: 1, master_id: id, status: 'Свободен' };
        },
        async cancel(...args) {
            calls.push(['cancel', ...args]);
            if (error) throw error;
            return { deleted: false, booking: { booking_id: 7, slot_id: args[1], status: 'Отменена мастером', reason: 'plans' } };
        },
        async delete(...args) {
            calls.push(['delete', ...args]);
            if (error) throw error;
        },
    };
    const env: Record<string, string | undefined> = { BOT_TOKEN: botToken, SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'secret', ...config };
    const handler = createSlotsWriteHandler({ env: (key) => env[key], nowSeconds: () => now,
        createRepository: () => { creations++; return repository; } });
    return { calls, get creations() { return creations; }, handler,
        request: (body: unknown, options: RequestInit = {}, suffix = '') => handler(new Request('https://example.test' + suffix, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
        })),
    };
}
const create = (patch = {}) => ({ action: 'create', init_data: signInitData(), ...input, ...patch });
const cancel = (patch = {}) => ({ action: 'cancel', init_data: signInitData(), slot_id: 1, ...patch });
const remove = (patch = {}) => ({ action: 'delete', init_data: signInitData(), slot_id: 1, ...patch });

test('both deletion paths return a history conflict without exposing SQL details or retrying', async () => {
    for (const body of [remove(), cancel()]) {
        const f = fixture({ code: 'PT409', message: 'BB73_SLOT_HAS_HISTORY', details: 'private' });
        const response = await f.request(body);
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: {
            code: 'SLOT_HAS_HISTORY', message: 'A slot with booking history cannot be deleted.',
        } });
        assert.equal(f.calls.length, 1);
    }
});

test('BB-06 rejects missing, forged, expired, future, duplicate and malformed authorization before DB', async () => {
    for (const init_data of [undefined, '', 'broken', signInitData({}, 'fake'), signInitData({ auth_date: String(now - 86401) }), signInitData({ auth_date: String(now + 1) }), signInitData() + '&user=x']) {
        for (const body of [create({ init_data }), remove({ init_data }), cancel({ init_data })]) {
            const f = fixture();
            assert.equal((await f.request(body)).status, 401);
            assert.equal(f.creations, 0);
        }
    }
});

test('ownership, statuses, roles, nested identity and slot IDs cannot be injected into creation', async () => {
    for (const field of ['master_id', 'masterId', 'user_id', 'userId', 'status', 'role', 'is_admin', 'profile', 'initDataUnsafe']) {
        for (const body of [create({ [field]: 777 }), remove({ [field]: 777 }), cancel({ [field]: 777 })]) {
            const f = fixture();
            assert.equal((await f.request(body)).status, 400);
            assert.equal(f.creations, 0);
        }
    }
    const f = fixture();
    assert.equal((await f.request(create({ slot_id: 99 }))).status, 400);
    assert.equal(f.creations, 0);
});

test('valid create/delete use only signed actor, preserve response and normalize offset', async () => {
    const f = fixture();
    const response = await f.request(create({ date_time: '2030-01-01T15:00:00+03:00', city: ' Москва ' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { slot: { ...input, slot_id: 1, master_id: actor.id, status: 'Свободен' } });
    assert.deepEqual(await (await f.request(remove())).json(), { deleted: true });
    assert.deepEqual(f.calls, [['create', actor.id, input], ['delete', actor.id, 1]]);
});

test('invalid IDs, calendar dates, text types and policy lengths never reach DB', async () => {
    const patches = [
        ...[0, -1, 1.5, {}, null, true, '1 OR 1=1', Number.MAX_SAFE_INTEGER + 1].map(service_id => ({ service_id })),
        ...['2030-02-30T12:00:00Z', '2030-01-01T24:00:00Z', '2030-13-01T12:00:00Z', '2030-01-01T12:00:60Z', '2030-01-01T12:00:00+24:00', '2030-01-01T12:00', 'infinity', null].map(date_time => ({ date_time })),
        ...['', ' ', 'Город', 'x'.repeat(201), null, {}, 'a\u0000b'].map(city => ({ city })),
        { address: 'x'.repeat(501) }, { address: null }, { description: 'x'.repeat(2001) }, { description: {} },
    ];
    for (const patch of patches) {
        const f = fixture();
        assert.equal((await f.request(create(patch))).status, 400, JSON.stringify(patch));
        assert.equal(f.creations, 0);
    }
    for (const slot_id of [0, null, false, -1, 'bad', 1.2]) {
        const f = fixture();
        assert.equal((await f.request(remove({ slot_id }))).status, 400);
        assert.equal(f.creations, 0);
    }
});

test('past and equal-to-now instants are rejected', async () => {
    for (const date_time of ['2000-01-01T00:00:00Z', new Date(now * 1000).toISOString()]) {
        const f = fixture();
        assert.equal((await f.request(create({ date_time }))).status, 409);
        assert.equal(f.creations, 0);
    }
});

test('foreign/missing, occupied, invalid service, expired and duplicate RPC results are sanitized; no retry', async () => {
    for (const [code, status, expected] of [
        ['PT404', 404, 'SLOT_NOT_FOUND'], ['PT409', 409, 'SLOT_UNAVAILABLE'],
        ['PT422', 400, 'INVALID_REQUEST'], ['PT410', 409, 'SLOT_EXPIRED'],
        ['23505', 409, 'SLOT_DUPLICATE'], ['XX000', 500, 'SLOTS_UNAVAILABLE'],
    ] as const) {
        const f = fixture({ code, message: 'private slots_one_live_time_per_master' });
        const response = await f.request(code === 'PT404' || code === 'PT409' ? remove() : create());
        assert.equal(response.status, status);
        const body = await response.json();
        assert.equal(body.error.code, expected);
        assert.ok(!JSON.stringify(body).includes('private'));
        assert.equal(f.calls.length, 1);
    }
});

test('transport, config and unexpected server errors fail closed', async () => {
    const f = fixture(new Error('private DB error'));
    assert.equal((await f.request(create())).status, 500);
    assert.equal((await f.request(create(), { body: '{broken' })).status, 400);
    assert.equal((await f.request(create(), {}, '?master_id=7')).status, 400);
    assert.equal((await f.request(create(), { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await f.request(create({ description: 'x'.repeat(17000) }))).status, 413);
    assert.equal((await f.handler(new Request('https://example.test'))).status, 405);
    assert.equal((await f.handler(new Request('https://example.test', { method: 'OPTIONS' }))).status, 200);
    for (const config of [{ BOT_TOKEN: undefined }, { SUPABASE_SERVICE_ROLE_KEY: '' }, { SUPABASE_SECRET_KEYS: '{broken' }, { SUPABASE_URL: '' }]) {
        const bad = fixture(undefined, config);
        assert.equal((await bad.request(create())).status, 503);
        assert.equal(bad.creations, 0);
    }
});


test('cancel resolves the signed master and keeps the UI result; SQL errors have no fallback', async () => {
    const f = fixture();
    const response = await f.request(cancel());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { deleted: false, booking: {
        booking_id: 7, slot_id: 1, status: 'Отменена мастером', reason: 'plans',
    } });
    assert.deepEqual(f.calls, [['cancel', actor.id, 1]]);
    for (const [code, status] of [['PT404', 404], ['PT409', 409], ['XX000', 500]] as const) {
        const bad = fixture({ code, message: 'private SQL error' });
        const result = await bad.request(cancel());
        assert.equal(result.status, status);
        assert.ok(!JSON.stringify(await result.json()).includes('private'));
        assert.deepEqual(bad.calls, [['cancel', actor.id, 1]]);
    }
    for (const slot_id of [null, 0, -1, 'bad', true, 1.2]) {
        const bad = fixture();
        assert.equal((await bad.request(cancel({ slot_id }))).status, 400);
        assert.equal(bad.creations, 0);
    }
    for (const field of ['reason', 'booking_id']) {
        const bad = fixture();
        assert.equal((await bad.request(cancel({ [field]: 'plans' }))).status, 400);
        assert.equal(bad.creations, 0);
    }
});
