// Test doubles intentionally implement asynchronous interfaces without I/O.
// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Browser module intentionally remains plain JavaScript.
import {
    createCatalogClient,
    getAvailableCities,
    getAvailableServiceCounts,
    getServices,
} from '../../../../webapp/js/data/services.js';

const service = {
    service_id: 1,
    name: 'Стрижка',
    icon_url: null,
    duration: null,
    description: null,
};

test('client methods retain their return contracts and send only signed initData and action', async () => {
    const payloads = { services: [service], counts: { 1: 1234 }, cities: ['Москва'] };
    const fetchImpl: typeof fetch = async (input, init) => {
        assert.equal(String(input), 'https://example.test/functions/v1/catalog');
        assert.equal(init?.method, 'POST');
        assert.equal(init?.cache, 'no-store');
        assert.equal(init?.credentials, 'omit');
        assert.equal(init?.redirect, 'error');
        assert.equal(new Headers(init?.headers).get('apikey'), 'public-key');
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(Object.keys(body).sort(), ['action', 'init_data']);
        assert.equal(body.init_data, 'signed-init-data');
        return Response.json({ [body.action]: payloads[body.action as keyof typeof payloads] });
    };
    const client = createCatalogClient({
        url: 'https://example.test',
        key: 'public-key',
        getInitData: () => 'signed-init-data',
        fetchImpl,
    });
    assert.deepEqual(await client.getServices(), [service]);
    assert.deepEqual(await client.getAvailableServiceCounts(), { 1: 1234 });
    assert.deepEqual(await client.getAvailableCities(), ['Москва']);
});

test('missing initData rejects without making a request', async () => {
    let calls = 0;
    const client = createCatalogClient({
        url: 'https://example.test',
        key: 'public-key',
        getInitData: () => '',
        fetchImpl: async () => {
            calls++;
            return Response.json({});
        },
    });
    for (
        const action of ['getServices', 'getAvailableServiceCounts', 'getAvailableCities'] as const
    ) {
        await assert.rejects(client[action], { code: 'UNAUTHORIZED', status: 401 });
    }
    assert.equal(calls, 0);
});

test('client rejects network, JSON, HTTP and malformed response errors with safe messages', async () => {
    for (
        const fetchImpl of [
            async () => {
                throw new Error('server-secret');
            },
            async () => new Response('not-json'),
            async () => Response.json({ error: { message: 'server-secret' } }, { status: 500 }),
            async () => Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
            async () => Response.json({}),
            async () => Response.json({ services: [{}], counts: [], cities: [1] }),
            async () => Response.json({ services: null, counts: { 1: -1 }, cities: null }),
        ]
    ) {
        const client = createCatalogClient({
            url: 'https://example.test',
            key: 'public-key',
            getInitData: () => 'signed-init-data',
            fetchImpl,
        });
        for (
            const action of [
                'getServices',
                'getAvailableServiceCounts',
                'getAvailableCities',
            ] as const
        ) {
            await assert.rejects(client[action], (error: unknown) => {
                assert(error instanceof Error);
                assert(!error.message.includes('server-secret'));
                return true;
            });
        }
    }
});

test('existing exports invoke the catalog API with current Telegram initData', async () => {
    const originalFetch = globalThis.fetch;
    const root = globalThis as unknown as { window?: unknown };
    const originalWindow = root.window;
    root.window = { Telegram: { WebApp: { initData: 'signed-current' } } };
    try {
        let calls = 0;
        globalThis.fetch = async (_input, init) => {
            const body = JSON.parse(String(init?.body));
            assert.equal(body.init_data, 'signed-current');
            calls++;
            return Response.json({ services: [], counts: {}, cities: [] });
        };
        assert.deepEqual(await getServices(), []);
        assert.deepEqual(await getAvailableServiceCounts(), {});
        assert.deepEqual(await getAvailableCities(), []);
        assert.equal(calls, 3);
    } finally {
        globalThis.fetch = originalFetch;
        root.window = originalWindow;
    }
});
