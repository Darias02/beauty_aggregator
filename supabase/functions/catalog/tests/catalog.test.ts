// Test doubles intentionally implement asynchronous interfaces without I/O.
// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogHandler } from '../handler.ts';
import type { CatalogRepository } from '../handler.ts';

const token = 'catalog-test-token';
const now = 1800000000;
const config: Record<string, string> = {
    BOT_TOKEN: token,
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'server-secret',
};

async function signed(authDate = now, user = { id: 42, first_name: 'Test' }) {
    const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
    const encode = (value: string) => new TextEncoder().encode(value);
    const key = await crypto.subtle.importKey(
        'raw',
        encode('WebAppData'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const secret = await crypto.subtle.sign('HMAC', key, encode(token));
    const dataKey = await crypto.subtle.importKey(
        'raw',
        secret,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const check = [...params].sort(([a], [b]) => a < b ? -1 : 1)
        .map(([key, value]) => `${key}=${value}`).join('\n');
    const hash = await crypto.subtle.sign('HMAC', dataKey, encode(check));
    params.set(
        'hash',
        [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
    return params.toString();
}

function request(body: unknown, headers = { 'Content-Type': 'application/json' }) {
    return new Request('https://example.test/catalog', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

function setup(overrides: Partial<CatalogRepository> = {}, env = config) {
    let created = 0;
    const repository: CatalogRepository = {
        getServices: async () => [],
        getAvailableServiceCounts: async () => ({}),
        getAvailableCities: async () => [],
        ...overrides,
    };
    const handler = createCatalogHandler({
        env: (name) => env[name],
        nowSeconds: () => now,
        createRepository: (url, key) => {
            assert.equal(url, config.SUPABASE_URL);
            assert.equal(key, config.SUPABASE_SERVICE_ROLE_KEY);
            created++;
            return repository;
        },
    });
    return { handler, created: () => created };
}

test('all operations authenticate and return empty contract values', async () => {
    const { handler } = setup();
    for (const [action, empty] of [['services', []], ['counts', {}], ['cities', []]] as const) {
        const response = await handler(request({ action, init_data: await signed() }));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { [action]: empty });
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    }
});

test('invalid, forged, expired, future and duplicated initData never access the database', async () => {
    const { handler, created } = setup();
    const valid = await signed();
    for (
        const init_data of [
            undefined,
            '',
            'invalid',
            valid.replace('Test', 'Forged'),
            await signed(now - 86401),
            await signed(now + 1),
            `${valid}&auth_date=${now}`,
        ]
    ) {
        for (const action of ['services', 'counts', 'cities']) {
            const response = await handler(request({ action, init_data }));
            assert.equal(response.status, 401);
            assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
        }
    }
    assert.equal(created(), 0);
});

test('services expose only fields used by the existing UI', async () => {
    const service = {
        service_id: 1,
        name: 'Стрижка',
        icon_url: null,
        duration: null,
        description: 'Описание',
        private_key: 'server-secret',
    };
    const { handler } = setup({ getServices: async () => [service] });
    const response = await handler(request({ action: 'services', init_data: await signed() }));
    const { private_key: _private, ...expected } = service;
    assert.deepEqual(await response.json(), { services: [expected] });
});

test('malformed requests, forbidden fields and unknown actions fail before repository creation', async () => {
    const { handler, created } = setup();
    const init_data = await signed();
    for (
        const body of [null, [], { init_data, action: 'delete' }, {
            init_data,
            action: 'counts',
            user_id: 7,
        }, { init_data, action: 'cities', filter: '*' }]
    ) {
        assert.equal((await handler(request(body))).status, 400);
    }
    assert.equal(
        (await handler(
            new Request('https://example.test/catalog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{',
            }),
        )).status,
        400,
    );
    assert.equal((await handler(request({}, { 'Content-Type': 'text/plain' }))).status, 415);
    assert.equal((await handler(request({ padding: 'a'.repeat(17000) }))).status, 413);
    assert.equal(
        (await handler(
            new Request('https://example.test/catalog?x=1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            }),
        )).status,
        400,
    );
    assert.equal(created(), 0);
});

test('preflight and unsupported methods never access the database', async () => {
    const { handler, created } = setup();
    assert.equal(
        (await handler(new Request('https://example.test/catalog', { method: 'OPTIONS' }))).status,
        200,
    );
    const response = await handler(new Request('https://example.test/catalog'));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST, OPTIONS');
    assert.equal(created(), 0);
});

test('configuration and repository failures never leak internal errors', async () => {
    const init_data = await signed();
    for (const action of ['services', 'counts', 'cities']) {
        const fail = async (): Promise<never> => {
            throw new Error('server-secret sql private data');
        };
        const { handler } = setup({
            getServices: fail,
            getAvailableServiceCounts: fail,
            getAvailableCities: fail,
        });
        const response = await handler(request({ action, init_data }));
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), {
            error: {
                code: 'CATALOG_UNAVAILABLE',
                message: 'Catalog service is unavailable.',
            },
        });
    }
    for (
        const env of [{}, { ...config, SUPABASE_SERVICE_ROLE_KEY: '' }, {
            ...config,
            SUPABASE_SECRET_KEYS: '{broken',
        }, { ...config, SUPABASE_URL: '' }]
    ) {
        const { handler, created } = setup({}, env);
        assert.equal((await handler(request({ action: 'counts', init_data }))).status, 503);
        assert.equal(created(), 0);
    }
});
