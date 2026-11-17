// Test doubles implement async interfaces without I/O.
// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseSlotsRepository } from '../repository.ts';
import type { Slot } from '../repository.ts';

type Booking = {
    booking_id: number;
    user_id: number;
    slot_id: number;
    status: string;
    reason: string | null;
};
const now = '2026-10-31T12:00:00.000Z';
const slot = (slot_id: number, patch: Partial<Slot> = {}): Slot => ({
    slot_id,
    date_time: '2030-01-01T12:00:00Z',
    status: 'Свободен',
    master_id: 77,
    service_id: 2,
    city: 'Москва',
    address: 'Адрес',
    description: 'Описание',
    services: { service_id: 2, name: 'Услуга' },
    ...patch,
});
function fixture(slots: Slot[], bookings: Booking[] = [], cap = 137, failAt = -1) {
    const calls: URL[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        assert.equal(new Headers(init?.headers).get('apikey'), 'server-key');
        assert.equal(init?.method, 'GET');
        if (calls.length === failAt) {
            return Response.json({ message: 'private error' }, { status: 500 });
        }
        const table = url.pathname.split('/').pop();
        assert.ok(table === 'slots' || table === 'bookings');
        let rows: Record<string, unknown>[] = (table === 'slots' ? slots : bookings).map((row) => ({
            ...row,
        }));
        const params = url.searchParams;
        assert.equal(
            params.get('select'),
            table === 'slots'
                ? 'slot_id,date_time,status,master_id,service_id,city,address,description,services(service_id,name)'
                : 'slot_id',
        );
        if (table === 'bookings') {
            assert.equal(params.get('user_id'), 'eq.42');
            assert.equal(params.get('status'), 'eq.Отменена мастером');
            assert.equal(params.get('reason'), 'eq.model');
        }
        for (const [key, value] of params) {
            if (['select', 'order', 'offset', 'limit'].includes(key)) continue;
            const separator = value.indexOf('.');
            const op = value.slice(0, separator), expected = value.slice(separator + 1);
            assert.ok(['eq', 'gt'].includes(op));
            rows = rows.filter((row) =>
                op === 'eq'
                    ? String(row[key]) === expected
                    : Date.parse(String(row[key])) > Date.parse(expected)
            );
        }
        if (params.has('offset')) {
            assert.equal(
                params.get('order'),
                table === 'slots' ? 'date_time.asc,slot_id.asc' : 'booking_id.asc',
            );
        }
        const keys = table === 'slots' ? ['date_time', 'slot_id'] : ['booking_id'];
        rows.sort((a, b) => {
            for (const key of keys) {
                const left = key === 'date_time' ? Date.parse(String(a[key])) : Number(a[key]);
                const right = key === 'date_time' ? Date.parse(String(b[key])) : Number(b[key]);
                if (left !== right) return left - right;
            }
            return 0;
        });
        const offset = Number(params.get('offset') || 0),
            limit = Math.min(Number(params.get('limit') || cap), cap);
        return Response.json(rows.slice(offset, offset + limit));
    };
    return {
        calls,
        repository: createSupabaseSlotsRepository('https://example.test', 'server-key', fetchImpl),
    };
}
const rejection = (slot_id: number, patch: Partial<Booking> = {}): Booking => ({
    booking_id: slot_id,
    user_id: 42,
    slot_id,
    status: 'Отменена мастером',
    reason: 'model',
    ...patch,
});

test('public filters preserve service, exact city, status, future date and actor rejection', async () => {
    const slots = [
        slot(1),
        slot(2, { service_id: 3 }),
        slot(3, { city: 'Казань' }),
        slot(4, { status: 'Занят' }),
        slot(5, { date_time: now }),
        slot(6, { date_time: '2020-01-01' }),
        slot(7),
        slot(8),
        slot(9),
    ];
    const { repository } = fixture(slots, [
        rejection(1),
        rejection(7, { user_id: 999 }),
        rejection(8, { reason: 'plans' }),
        rejection(9, { status: 'Активна' }),
    ]);
    assert.deepEqual(
        (await repository.getAvailableSlots(42, 2, 'Москва', now)).map((s) => s.slot_id),
        [7, 8, 9],
    );
    assert.deepEqual((await repository.getAvailableSlots(42, 2, null, now)).map((s) => s.slot_id), [
        3,
        7,
        8,
        9,
    ]);
});

test('single access: own archive allowed; foreign private, past and hidden are indistinguishable from missing', async () => {
    const rows = [
        slot(1),
        slot(2, { status: 'Занят' }),
        slot(3, { status: 'Отменен' }),
        slot(4, { date_time: now }),
        slot(5),
        slot(6, { master_id: 42, status: 'Отменен', date_time: '2020-01-01' }),
    ];
    const { repository } = fixture(rows, [rejection(5), rejection(6)]);
    assert.deepEqual(await repository.getSlot(42, 1, now), rows[0]);
    for (const id of [2, 3, 4, 5, 999]) assert.equal(await repository.getSlot(42, id, now), null);
    assert.deepEqual(await repository.getSlot(42, 6, now), rows[5]);
});

for (const cap of [1000, 137, 1]) {
    test(`lists and hidden IDs paginate beyond server cap ${cap}, retaining equal-date order`, async () => {
        const count = cap === 1 ? 31 : 1607;
        const slots = Array.from(
            { length: count },
            (_, i) => slot(i + 1, { master_id: i % 2 ? 42 : 77 }),
        ).reverse();
        const bookings = Array.from({ length: count - 2 }, (_, i) => rejection(i + 1)).reverse();
        const { repository } = fixture(slots, bookings, cap);
        assert.deepEqual(
            (await repository.getAvailableSlots(42, 2, null, now)).map((s) => s.slot_id),
            [count - 1, count],
        );
        assert.deepEqual(
            await repository.getMasterSlots(42),
            slots.filter((s) => s.master_id === 42).reverse(),
        );
    });
}

test('empty results and later page errors never return partial lists', async () => {
    const empty = fixture([]).repository;
    assert.deepEqual(await empty.getAvailableSlots(42, 2, null, now), []);
    assert.deepEqual(await empty.getMasterSlots(42), []);
    assert.equal(await empty.getSlot(42, 1, now), null);
    const rows = Array.from({ length: 10 }, (_, i) => slot(i + 1, { master_id: 42 }));
    await assert.rejects(() =>
        fixture(rows, [], 2, 3).repository.getAvailableSlots(42, 2, null, now)
    );
    await assert.rejects(() => fixture(rows, [], 2, 2).repository.getMasterSlots(42));
    await assert.rejects(() =>
        fixture(rows, [rejection(1), rejection(2), rejection(3)], 2, 2).repository
            .getAvailableSlots(42, 2, null, now)
    );
});
