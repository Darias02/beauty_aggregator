import assert from 'node:assert/strict';
import { createAddressSuggestHandler } from '../handler.ts';
import { botToken, now, signInitData } from '../../user-profile/tests/helpers.ts';

const cityId = '0c5b2444-70a0-4932-980c-b4dc0d3f02b5';
const config: Record<string, string> = {
    BOT_TOKEN: botToken,
    DADATA_API_KEY: 'private-test-token',
    DADATA_FREE_TIER_ENABLED: 'true',
};
const provider = {
    suggestions: [
        {
            value: 'г Москва',
            data: { country_iso_code: 'RU', city: 'Москва', city_fias_id: cityId },
        },
        {
            value: 'Московская обл, г Зеленоград',
            data: { country_iso_code: 'RU', city: 'Зеленоград', city_fias_id: null },
        },
    ],
};
function fixture(options: { config?: Record<string, string>; fetchImpl?: typeof fetch } = {}) {
    const calls: { url: string; options?: RequestInit }[] = [];
    let clock = now;
    const handler = createAddressSuggestHandler({
        env: (key) => (options.config ?? config)[key],
        nowSeconds: () => clock,
        fetchImpl: options.fetchImpl ?? ((url, options) => {
            calls.push({ url: String(url), options });
            return Promise.resolve(Response.json(provider));
        }),
    });
    return {
        handler,
        calls,
        advance: () => {
            clock += 60;
        },
        request: (patch: Record<string, unknown> = {}) =>
            handler(
                new Request('https://local.test/address-suggest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        init_data: signInitData(),
                        mode: 'city',
                        query: 'Мос',
                        ...patch,
                    }),
                }),
            ),
    };
}

Deno.test('authentic Telegram init_data is required before any provider call', async () => {
    for (
        const init_data of [
            undefined,
            '',
            'forged',
            signInitData({}, 'wrong'),
            signInitData({ auth_date: String(now - 86401) }),
            signInitData({ auth_date: String(now + 1) }),
            signInitData() + '&user=x',
        ]
    ) {
        const f = fixture();
        assert.equal((await f.request({ init_data })).status, 401);
        assert.equal(f.calls.length, 0);
    }
});
Deno.test('strict input, bounded bodies and fixed provider prevent arbitrary proxying', async () => {
    for (
        const patch of [
            { mode: 'clean' },
            { mode: null },
            { query: 'a' },
            { query: ' '.repeat(4) },
            { query: 'x'.repeat(201) },
            { query: '\u202eМос' },
            { query: {} },
            { city_id: 'not-a-uuid' },
            { city: 'Москва' },
            { url: 'https://evil.test' },
            { master_id: 777 },
            { city_id: cityId },
            { query: 'x'.repeat(20000) },
        ]
    ) {
        const f = fixture();
        assert.equal((await f.request(patch)).status, 400, JSON.stringify(patch));
        assert.equal(f.calls.length, 0);
    }
    const f = fixture();
    assert.equal(
        (await f.handler(new Request('https://local.test/', { method: 'GET' }))).status,
        405,
    );
    assert.equal(
        (await f.handler(new Request('https://local.test/', { method: 'OPTIONS' }))).status,
        200,
    );
    assert.equal(
        (await f.handler(
            new Request('https://local.test/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{broken',
            }),
        )).status,
        400,
    );
});
Deno.test('city results keep compatible text; only minimum fields leave the server', async () => {
    const f = fixture();
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
        suggestions: [
            { label: 'г Москва', value: 'Москва', cityId },
            { label: 'Московская обл, г Зеленоград', value: 'Зеленоград', cityId: null },
        ],
    });
    const call = f.calls[0];
    assert.equal(call.url, 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address');
    assert.equal(
        new Headers(call.options?.headers).get('Authorization'),
        'Token private-test-token',
    );
    assert.deepEqual(JSON.parse(String(call.options?.body)), {
        query: 'Мос',
        count: 5,
        language: 'ru',
        locations: [{ country_iso_code: 'RU' }],
        from_bound: { value: 'city' },
        to_bound: { value: 'city' },
    });
    assert.equal(call.options?.redirect, 'error');
    assert.ok(call.options?.signal);
    assert.ok(!String(call.options?.body).includes('init_data'));
});
Deno.test('addresses use selected city ID or manual city, profile searches across Russia', async () => {
    const f = fixture();
    for (const patch of [{ city: 'Москва', city_id: cityId }, { city: 'Казань' }, {}]) {
        assert.equal((await f.request({ mode: 'address', query: 'Ленина', ...patch })).status, 200);
    }
    assert.deepEqual(f.calls.map((call) => JSON.parse(String(call.options?.body)).locations), [
        [{ country_iso_code: 'RU', city_fias_id: cityId }],
        [{ country_iso_code: 'RU', city: 'Казань' }],
        [{ country_iso_code: 'RU' }],
    ]);
});
Deno.test('disabled/missing free-tier configuration fails closed', async () => {
    for (
        const settings of [{}, { ...config, DADATA_API_KEY: '' }, {
            ...config,
            DADATA_FREE_TIER_ENABLED: 'false',
        }]
    ) {
        const f = fixture({ config: settings });
        const response = await f.request();
        assert.equal(response.status, 503);
        assert.equal(f.calls.length, 0);
    }
});
Deno.test('provider quota, denial, network, timeout and bad responses permit safe manual fallback', async () => {
    const providers: typeof fetch[] = [
        () => Promise.resolve(new Response('private quota detail', { status: 403 })),
        () => Promise.resolve(new Response('private limit detail', { status: 429 })),
        () => Promise.reject(new Error('private network detail')),
        () => Promise.reject(new DOMException('private timeout detail', 'TimeoutError')),
        () => Promise.resolve(new Response('{broken')),
        () => Promise.resolve(Response.json({ unexpected: true })),
        () => Promise.resolve(new Response('x'.repeat(131073))),
    ];
    for (const fetchImpl of providers) {
        const response = await fixture({ fetchImpl }).request();
        assert.ok([429, 503].includes(response.status));
        const text = await response.text();
        assert.ok(!text.includes('private'));
        assert.ok(!text.includes('test-token'));
    }
});
Deno.test('best-effort per-isolate throttle caps calls and resets, without claiming cross-instance state', async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) assert.equal((await f.request()).status, 200);
    const limited = await f.request();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(f.calls.length, 30);
    // A different Edge instance has independent counters. Daily cap belongs to DaData.
    assert.equal((await fixture().request()).status, 200);
    f.advance();
    assert.equal((await f.request()).status, 200);
});
Deno.test('provider responses are filtered, bounded and never returned raw', async () => {
    const result = await fixture({
        fetchImpl: () =>
            Promise.resolve(Response.json({
                suggestions: [
                    {
                        value: '<b>Москва</b>',
                        data: { city: 'Москва', country_iso_code: 'RU', secret: 'private' },
                    },
                    {
                        value: 'Иностранный город',
                        data: { city: 'Elsewhere', country_iso_code: 'US' },
                    },
                    { value: '\u202eМосква', data: { city: 'Москва', country_iso_code: 'RU' } },
                    null,
                    { value: 'x'.repeat(501), data: { city: 'Москва', country_iso_code: 'RU' } },
                ],
            })),
    }).request();
    assert.deepEqual(await result.json(), {
        suggestions: [{ label: '<b>Москва</b>', value: 'Москва', cityId: null }],
    });
});
