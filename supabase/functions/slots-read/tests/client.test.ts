// Test doubles implement async interfaces without I/O.
// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
    new URL('../../../../webapp/js/data/slots.js', import.meta.url),
    'utf8',
);
// Run the real module with browser-only imports replaced; direct DB access must fail.
const code = source.replace(/^import .*;\n/gm, '')
    .replace(
        'const client = createSlotsReadClient({',
        'const APP_CONFIG = { supabase: { url: "https://example.test", key: "public-key" } }; const getTelegramInitData = () => "signed"; const supabase = { from() { throw new Error("Forbidden table access"); } };\nconst client = createSlotsReadClient({',
    );
const { createSlotsReadClient } = await import(
    'data:text/javascript;base64,' + btoa(String.fromCharCode(...new TextEncoder().encode(code)))
);
const slot = {
    slot_id: 1,
    date_time: '2030-01-01',
    status: 'Свободен',
    master_id: 77,
    service_id: 2,
    city: 'Москва',
    address: '',
    description: '',
    services: { service_id: 2, name: 'Услуга' },
};

test('legacy signatures preserve objects and never send browser actor IDs', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = createSlotsReadClient({
        url: 'https://example.test',
        key: 'public-key',
        getInitData: () => 'signed',
        fetchImpl: async (url: string, options: RequestInit) => {
            assert.equal(url, 'https://example.test/functions/v1/slots-read');
            assert.equal(options.cache, 'no-store');
            const body = JSON.parse(String(options.body));
            calls.push(body);
            return Response.json(body.action === 'slot' ? { slot } : { slots: [slot] });
        },
    });
    assert.deepEqual(await client.getAvailableSlots(2, 'Москва', 999), [slot]);
    assert.deepEqual(await client.getSlot(1), slot);
    assert.deepEqual(await client.getMasterSlots(999), [slot]);
    assert.deepEqual(calls, [
        { action: 'available', service_id: 2, city: 'Москва', init_data: 'signed' },
        { action: 'slot', slot_id: 1, init_data: 'signed' },
        { action: 'master', init_data: 'signed' },
    ]);
    assert.deepEqual(await client.getAvailableSlots(null), []);
    assert.equal(calls.length, 3);
});

test('auth, network, HTTP and malformed responses reject with no fallback', async () => {
    let calls = 0;
    const client = (fetchImpl: typeof fetch, init = 'signed') =>
        createSlotsReadClient({
            url: 'https://example.test',
            key: 'public-key',
            getInitData: () => init,
            fetchImpl,
        });
    await assert.rejects(() =>
        client(async () => {
            calls++;
            return Response.json({});
        }, '').getMasterSlots(999), { code: 'UNAUTHORIZED' });
    assert.equal(calls, 0);
    for (
        const response of [
            Response.json({}, { status: 401 }),
            Response.json({}, { status: 500 }),
            Response.json({ slots: {} }),
            new Response('broken'),
            Response.json({ slots: [{ slot_id: 1 }] }),
        ]
    ) {
        await assert.rejects(() =>
            client(async () => {
                calls++;
                return response;
            }).getMasterSlots(999)
        );
    }
    await assert.rejects(() =>
        client(async () => {
            throw new Error('offline');
        }).getSlot(1)
    );
    assert.equal(calls, 5);
    assert.equal(await client(async () => Response.json({ slot: null })).getSlot(999), null);
    assert.ok(
        !source.slice(0, source.indexOf('export async function cancelSlot')).includes('.from('),
    );
});
