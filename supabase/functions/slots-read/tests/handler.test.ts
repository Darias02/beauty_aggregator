// Test doubles implement async interfaces without I/O.
// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSlotsHandler } from '../handler.ts';
import type { Slot, SlotsRepository } from '../repository.ts';

const now = 1793448000;
const token = 'test-only-token';
function signed(id = 42, age = 0) {
    const params = new URLSearchParams({
        user: JSON.stringify({ id, first_name: 'Test' }),
        auth_date: String(now - age),
    });
    const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) =>
        `${k}=${v}`
    ).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
    return params.toString();
}
const slot: Slot = {
    slot_id: 1,
    date_time: '2030-01-01T00:00:00Z',
    status: 'Свободен',
    master_id: 77,
    service_id: 2,
    city: 'Москва',
    address: 'Адрес',
    description: 'Описание',
    services: { service_id: 2, name: 'Услуга' },
};
function fixture(fail = false) {
    const calls: unknown[][] = [];
    let creations = 0;
    const repository: SlotsRepository = {
        async getAvailableSlots(...args) {
            calls.push(['available', ...args]);
            if (fail) throw new Error('private DB');
            return [{ ...slot, private_field: 'secret' } as Slot];
        },
        async getSlot(...args) {
            calls.push(['slot', ...args]);
            return slot;
        },
        async getMasterSlots(...args) {
            calls.push(['master', ...args]);
            return [slot];
        },
    };
    const handler = createSlotsHandler({
        env: (key) =>
            ({
                BOT_TOKEN: token,
                SUPABASE_URL: 'https://example.test',
                SUPABASE_SERVICE_ROLE_KEY: 'server-key',
            })[key],
        nowSeconds: () => now,
        createRepository: () => {
            creations++;
            return repository;
        },
    });
    const request = (body: unknown, options: RequestInit = {}) =>
        handler(
            new Request('https://example.test/slots-read', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                ...options,
            }),
        );
    return {
        request,
        handler,
        calls,
        get creations() {
            return creations;
        },
    };
}

test('missing, forged, expired, future and malformed initData never access repository', async () => {
    for (
        const init_data of [
            undefined,
            '',
            signed().replace('Test', 'Fake'),
            signed(42, 86401),
            signed(42, -1),
            'broken',
            signed() + '&user=x',
        ]
    ) {
        const f = fixture();
        assert.equal((await f.request({ action: 'master', init_data })).status, 401);
        assert.equal(f.creations, 0);
    }
});

test('IDs in body cannot select a different actor, including nested and camelCase fields', async () => {
    for (const action of ['master', 'slot', 'available']) {
        for (
            const field of [
                'master_id',
                'masterId',
                'user_id',
                'userId',
                'filters',
                'initDataUnsafe',
            ]
        ) {
            const f = fixture();
            const res = await f.request({
                action,
                init_data: signed(),
                ...(action === 'slot'
                    ? { slot_id: 1 }
                    : action === 'available'
                    ? { service_id: 2 }
                    : {}),
                [field]: 99,
            });
            assert.equal(res.status, 400);
            assert.equal(f.creations, 0);
        }
    }
    const f = fixture();
    assert.equal((await f.request({ action: 'master', init_data: signed(91) })).status, 200);
    assert.deepEqual(f.calls, [['master', 91]]);
});

test('available and single preserve UI shape, filters and server-owned clock without extra data', async () => {
    const f = fixture();
    const result = await f.request({
        action: 'available',
        service_id: '2',
        city: 'Москва',
        init_data: signed(),
    });
    assert.deepEqual(await result.json(), { slots: [slot] });
    assert.deepEqual(f.calls[0], [
        'available',
        42,
        2,
        'Москва',
        new Date(now * 1000).toISOString(),
    ]);
    for (const city of [null, '', 'Город']) {
        await f.request({ action: 'available', service_id: 2, city, init_data: signed() });
    }
    assert.ok(f.calls.slice(1).every((call) => call[3] === null));
    assert.deepEqual(
        await (await f.request({ action: 'slot', slot_id: 1, init_data: signed() })).json(),
        { slot },
    );
    assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('validation, methods, body size and errors fail closed', async () => {
    const f = fixture();
    for (const service_id of [0, -1, 1.5, '1 OR 1=1', Number.MAX_SAFE_INTEGER + 1, {}, null]) {
        assert.equal(
            (await f.request({ action: 'available', service_id, init_data: signed() })).status,
            400,
        );
    }
    assert.equal((await f.request({ action: 'other', init_data: signed() })).status, 400);
    assert.equal(
        (await f.request({ action: 'master', init_data: signed(), city: 'x'.repeat(17000) }))
            .status,
        413,
    );
    assert.equal((await f.request({}, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal(
        (await f.handler(new Request('https://example.test', { method: 'GET' }))).status,
        405,
    );
    assert.equal(
        (await f.handler(new Request('https://example.test', { method: 'OPTIONS' }))).status,
        200,
    );
    const res = await fixture(true).request({
        action: 'available',
        service_id: 2,
        init_data: signed(),
    });
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes('private DB'));
});
