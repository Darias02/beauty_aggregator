// Test doubles intentionally implement asynchronous interfaces without I/O.
// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCatalogRepository } from '../repository.ts';

type Row = Record<string, unknown>;
// public.services in tests/bb24/schema.sql; UI-only fields must never reach SQL.
type ServiceRow = { service_id: number; name: string; description: string | null };
const serviceSchema = new Set(['service_id', 'name', 'description']);

function fixture(services: ServiceRow[] = [], slots: Row[] = [], cap = 1000, failAt = -1) {
    const calls: URL[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        assert.equal(new Headers(init?.headers).get('apikey'), 'server-key');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-key');
        if (calls.length === failAt) {
            return Response.json({ message: 'private database detail' }, { status: 500 });
        }
        const table = url.pathname.split('/').pop();
        let rows: Row[] = table === 'services' ? services : slots;
        const params = url.searchParams;
        const columns = params.get('select')!.split(',');
        if (table === 'services' && columns.some((column) => !serviceSchema.has(column))) {
            return Response.json({ code: '42703', message: 'Column does not exist' }, {
                status: 400,
            });
        }
        if (params.has('status')) {
            assert.equal(params.get('status'), 'eq.Свободен');
            rows = rows.filter((row) => row.status === 'Свободен');
        }
        if (params.has('city')) {
            assert.equal(params.get('city'), 'not.is.null');
            rows = rows.filter((row) => row.city !== null);
        }
        const order = table === 'services' ? 'service_id' : 'slot_id';
        assert.equal(params.get('order'), `${order}.asc`);
        rows = [...rows].sort((a, b) => Number(a[order]) - Number(b[order]));
        const offset = Number(params.get('offset'));
        const limit = Math.min(Number(params.get('limit')), cap);
        assert.equal(
            params.get('select'),
            table === 'services'
                ? 'service_id,name,description'
                : params.has('status')
                ? 'service_id'
                : 'city',
        );
        const data = rows.slice(offset, offset + limit)
            .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
        return Response.json(data);
    };
    return {
        calls,
        fetchImpl,
        repository: createSupabaseCatalogRepository(
            'https://example.test',
            'server-key',
            fetchImpl,
        ),
    };
}

const services = Array.from({ length: 150 }, (_, i) => ({
    service_id: i + 1,
    name: `Услуга ${i + 1}`,
    description: i % 2 ? 'Описание услуги' : null,
})).reverse();

test('repository preserves sorted 100-service contract and explicit fields under a small server cap', async () => {
    const { repository, calls } = fixture(services, [], 17);
    const result = await repository.getServices();
    assert.deepEqual(
        result,
        [...services].reverse().slice(0, 100).map((service) => ({
            ...service,
            icon_url: null,
            duration: null,
        })),
    );
    assert.equal(calls.length, 6);
});

test('schema mock rejects absent service columns even for empty tables', async () => {
    const { fetchImpl } = fixture();
    for (const column of ['icon_url', 'duration']) {
        const response = await fetchImpl(
            `https://example.test/rest/v1/services?select=service_id,${column}`,
            {
                headers: { apikey: 'server-key', authorization: 'Bearer server-key' },
            },
        );
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, '42703');
    }
});

test('repository returns all empty contracts', async () => {
    const { repository } = fixture();
    assert.deepEqual(await repository.getServices(), []);
    assert.deepEqual(await repository.getAvailableServiceCounts(), {});
    assert.deepEqual(await repository.getAvailableCities(), []);
});

for (const cap of [1000, 137]) {
    test(`counts and cities span many pages with server cap ${cap}`, async () => {
        const slots = Array.from({ length: 3207 }, (_, i) => ({
            slot_id: i + 1,
            service_id: (i % 3) + 1,
            status: i % 5 === 0 ? 'Занят' : 'Свободен',
            city: i === 3206 ? 'Ярославль' : i % 3 === 0 ? null : i % 3 === 1 ? ' Москва ' : ' ',
            private_field: 'must not be selected',
        })).reverse();
        const { repository } = fixture([], slots, cap);
        const expected: Record<string, number> = {};
        for (const slot of slots.filter((row) => row.status === 'Свободен')) {
            expected[slot.service_id] = (expected[slot.service_id] || 0) + 1;
        }
        assert.deepEqual(await repository.getAvailableServiceCounts(), expected);
        assert.deepEqual(await repository.getAvailableCities(), ['Москва', 'Ярославль']);
    });
}

test('cities preserve previous semantics, including busy slots, trim, deduplication and Russian order', async () => {
    const slots = [' Санкт-Петербург ', 'Москва', 'Москва ', null, '', ' ', 'Екатеринбург']
        .map((city, i) => ({ slot_id: i + 1, city, status: 'Занят' }));
    const { repository } = fixture([], slots, 2);
    assert.deepEqual(await repository.getAvailableCities(), [
        'Екатеринбург',
        'Москва',
        'Санкт-Петербург',
    ]);
});

test('a later page failure rejects instead of returning partial counts or cities', async () => {
    const slots = Array.from({ length: 600 }, (_, i) => ({
        slot_id: i + 1,
        service_id: 1,
        city: 'Москва',
        status: 'Свободен',
    }));
    for (const action of ['getAvailableServiceCounts', 'getAvailableCities'] as const) {
        const { repository } = fixture([], slots, 137, 2);
        await assert.rejects(() => repository[action]());
    }
    await assert.rejects(() => fixture([], [], 1000, 1).repository.getServices());
});
