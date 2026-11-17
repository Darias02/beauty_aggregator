// deno-lint-ignore-file require-await
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../../../webapp/js/data/slots.js', import.meta.url), 'utf8');
const code = source.replace(/^import .*;\n/gm, '').replace('const client = createSlotsReadClient({',
    'const APP_CONFIG = { supabase: { url: "https://example.test", key: "public" } }; const getTelegramInitData = () => "signed"; const supabase = { from() { throw new Error("Forbidden DB write"); } };\nconst client = createSlotsReadClient({');
const module = await import('data:text/javascript;base64,' + btoa(String.fromCharCode(...new TextEncoder().encode(code))));
const slot = { slot_id: 1, master_id: 42, service_id: 301, date_time: '2030-01-01T12:00:00.000Z', status: 'Свободен', city: 'Москва', address: '', description: '' };
const args = { masterId: 999, serviceId: 301, dateTime: slot.date_time, city: 'Москва' };

test('history conflicts keep both client operations failed with a clear message and no fallback', async () => {
    let calls = 0;
    const client = module.createSlotsWriteClient({
        url: 'https://example.test', key: 'public', getInitData: () => 'signed',
        fetchImpl: async () => {
            calls++;
            return Response.json({ error: { code: 'SLOT_HAS_HISTORY' } }, { status: 409 });
        },
    });
    for (const action of ['deleteSlot', 'cancelSlot']) {
        await assert.rejects(() => client[action](1, 999), {
            code: 'SLOT_HAS_HISTORY', status: 409,
            message: 'Нельзя удалить слот с историей записей. История сохранена.',
        });
    }
    assert.equal(calls, 2);
});

test('legacy signatures return slot/undefined, send only writable fields and signed initData', async () => {
    const calls: unknown[] = [];
    const client = module.createSlotsWriteClient({ url: 'https://example.test', key: 'public', getInitData: () => 'signed',
        fetchImpl: async (url: string, options: RequestInit) => {
            assert.equal(url, 'https://example.test/functions/v1/slots-write');
            assert.equal(options.cache, 'no-store');
            assert.equal(options.credentials, 'omit');
            assert.equal(options.redirect, 'error');
            const body = JSON.parse(String(options.body)); calls.push(body);
            return Response.json(body.action === 'create' ? { slot } : { deleted: true });
        } });
    assert.deepEqual(await client.createSlot(args), slot);
    assert.equal(await client.deleteSlot(1, 999), undefined);
    assert.deepEqual(calls, [
        { action: 'create', service_id: 301, date_time: slot.date_time, city: 'Москва', address: '', description: '', init_data: 'signed' },
        { action: 'delete', slot_id: 1, init_data: 'signed' },
    ]);
    assert.ok(!source.slice(source.indexOf('export function createSlotsWriteClient'), source.length).includes('.from('));
});

test('exported create/delete use API; network, auth, server and malformed errors never fall back or retry', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async () => { calls++; return Response.json({ slot }); };
        assert.deepEqual(await module.createSlot(args), slot);
        globalThis.fetch = async () => { calls++; return Response.json({ deleted: true }); };
        assert.equal(await module.deleteSlot(1, 999), undefined);
        assert.equal(calls, 2);
    } finally { globalThis.fetch = original; }
    for (const action of ['createSlot', 'deleteSlot', 'cancelSlot']) {
        let invoked = 0;
        const client = (response: () => Promise<Response>, init = 'signed') => module.createSlotsWriteClient({
            url: 'https://example.test', key: 'public', getInitData: () => init,
            fetchImpl: async () => { invoked++; return response(); },
        });
        const invoke = (c: Record<string, (...args: unknown[]) => Promise<unknown>>) => action === 'createSlot' ? c[action](args) : c[action](1, 999);
        await assert.rejects(() => invoke(client(async () => Response.json({}), '')), { code: 'UNAUTHORIZED' });
        assert.equal(invoked, 0);
        for (const response of [
            async () => { throw new Error('offline'); },
            async () => Response.json({}, { status: 401 }),
            async () => Response.json({ error: { code: 'SLOT_DUPLICATE' } }, { status: 409 }),
            async () => Response.json({ error: { code: 'private DB' } }, { status: 500 }),
            async () => new Response('not JSON'),
            async () => Response.json({ slot: {}, deleted: false }),
        ]) await assert.rejects(() => invoke(client(response)));
        assert.equal(invoked, 6);
    }
});


test('cancel preserves UI contract, ignores legacy identity and never reads bookings or falls back', async () => {
    assert.ok(!source.includes('.from('));
    assert.ok(!source.includes('./supabase.js'));
    const booking = { booking_id: 7, slot_id: 1, status: 'Отменена мастером', reason: 'plans' };
    const original = globalThis.fetch;
    let calls = 0;
    try {
        for (const result of [{ deleted: true }, { deleted: false, booking }]) {
            globalThis.fetch = async (url, options) => {
                calls++;
                assert.equal(url, 'https://example.test/functions/v1/slots-write');
                assert.deepEqual(JSON.parse(String(options?.body)), { action: 'cancel', slot_id: 1, init_data: 'signed' });
                return Response.json(result);
            };
            assert.deepEqual(await module.cancelSlot(1, 999), result);
        }
        assert.equal(calls, 2);
    } finally { globalThis.fetch = original; }
    for (const result of [{}, { deleted: false }, { deleted: true, booking },
        { deleted: false, booking: { ...booking, slot_id: 2 } },
        { deleted: false, booking: { ...booking, reason: 'model' } },
        { deleted: false, booking: { ...booking, status: 'Активна' } }]) {
        let invoked = 0;
        const c = module.createSlotsWriteClient({ url: 'https://example.test', key: 'public', getInitData: () => 'signed',
            fetchImpl: async () => { invoked++; return Response.json(result); } });
        await assert.rejects(() => c.cancelSlot(1, 999));
        assert.equal(invoked, 1);
    }
    const ui = await readFile(new URL('../../../../webapp/js/screens/master/records.js', import.meta.url), 'utf8');
    assert.match(ui, /if \(reason === 'model'\) \{\s*await rejectBooking\(record.booking_id, 'model'\)/);
    assert.match(ui, /if \(!result.deleted\)/);
});
