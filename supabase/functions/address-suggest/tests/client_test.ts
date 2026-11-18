import assert from 'node:assert/strict';
import { createAddressSuggestHandler } from '../handler.ts';
import { createAddressSuggestionsClient } from '../../../../webapp/js/data/address-suggestions.js';
import { botToken, now, signInitData } from '../../user-profile/tests/helpers.ts';

Deno.test('client → signed Edge handler → provider → filtered client suggestions', async () => {
    const env: Record<string, string> = {
        BOT_TOKEN: botToken,
        DADATA_API_KEY: 'private-token',
        DADATA_FREE_TIER_ENABLED: 'true',
    };
    const handler = createAddressSuggestHandler({
        env: (key) => env[key],
        nowSeconds: () => now,
        fetchImpl: () =>
            Promise.resolve(Response.json({
                suggestions: [{
                    value: 'г Казань',
                    data: { city: 'Казань', country_iso_code: 'RU' },
                }],
            })),
    });
    const suggest = createAddressSuggestionsClient({
        url: 'https://local.test',
        key: 'public-test-key',
        getInitData: signInitData,
        fetchImpl: (url, init) => {
            assert.equal(url, 'https://local.test/functions/v1/address-suggest');
            assert.equal(init?.cache, 'no-store');
            assert.equal(init?.credentials, 'omit');
            assert.equal(init?.redirect, 'error');
            assert.ok(!JSON.stringify(init).includes('private-token'));
            return handler(new Request(url, init));
        },
    });
    assert.deepEqual(await suggest({ mode: 'city', query: 'Каз' }), [
        { label: 'г Казань', value: 'Казань', cityId: null },
    ]);
});
Deno.test('client never calls endpoint without init_data; abort and bad responses remain failures', async () => {
    let calls = 0;
    const unauthenticated = createAddressSuggestionsClient({
        url: 'https://local.test',
        key: 'public',
        getInitData: () => '',
        fetchImpl: () => {
            calls++;
            return Promise.resolve(Response.json({ suggestions: [] }));
        },
    });
    await assert.rejects(() => unauthenticated({ mode: 'city', query: 'Каз' }));
    assert.equal(calls, 0);
    for (
        const result of [{}, { suggestions: [null] }, {
            suggestions: [{ label: 42, value: 'A', cityId: null }],
        }, { suggestions: Array(6).fill({ label: 'A', value: 'A', cityId: null }) }]
    ) {
        const suggest = createAddressSuggestionsClient({
            url: 'https://local.test',
            key: 'public',
            getInitData: signInitData,
            fetchImpl: () => Promise.resolve(Response.json(result)),
        });
        await assert.rejects(() => suggest({ mode: 'city', query: 'Каз' }));
    }
    const controller = new AbortController();
    controller.abort();
    const suggest = createAddressSuggestionsClient({
        url: 'https://local.test',
        key: 'public',
        getInitData: signInitData,
        fetchImpl: (_url, init) => {
            assert.equal(init?.signal, controller.signal);
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
        },
    });
    await assert.rejects(() => suggest({ mode: 'city', query: 'Каз', signal: controller.signal }));
});
