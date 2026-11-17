import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createBookingsWriteHandler } from '../handler.ts';
import { createSupabaseBookingsWriteRepository } from '../repository.ts';
import type { DecisionResult } from '../repository.ts';

const now = 1793448000;
const token = 'test-only-token';
function signed(age = 0) {
    const p = new URLSearchParams({ user: JSON.stringify({ id: 201, first_name: 'Master' }), auth_date: String(now - age) });
    const data = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    p.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
    return p.toString();
}
const result: DecisionResult = { booking: { booking_id: 3, slot_id: 5, user_id: 101, status: 'Активна', reason: null }, replayed: false };
const env = (key: string): string | undefined => ({ BOT_TOKEN: token, SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'server-key' } as Record<string, string>)[key];
function setup(impl = (...args: unknown[]) => { assert.deepEqual(args, [201, 3, 'confirm', null]); return Promise.resolve(result); }) {
    let calls = 0;
    const handler = createBookingsWriteHandler({ env, nowSeconds: () => now, createRepository: () => { calls++; return { decide: impl }; } });
    const request = (fields: Record<string, unknown> = {}, extra: RequestInit = {}) => handler(new Request('https://example.test/bookings-write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: signed(), action: 'confirm', booking_id: 3, ...fields }), ...extra,
    }));
    return { handler, request, calls: () => calls };
}

test('BB-06 identity reaches the server RPC; response preserves contract', async () => {
    const s = setup(); const r = await s.request({ booking_id: '3' });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), result);
    assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(s.calls(), 1);
});

test('invalid Telegram signatures and expired auth fail before repository creation', async () => {
    for (const init_data of ['', 'bad', signed(86401), signed().replace('Master', 'Other')]) {
        const s = setup(); assert.equal((await s.request({ init_data })).status, 401); assert.equal(s.calls(), 0);
    }
});

test('rejects injected identities, status, reason, IDs and unsupported operations', async () => {
    for (const fields of [{ master_id: 201 }, { actor_id: 201 }, { user_id: 101 }, { slot_id: 5 }, { status: 'Активна' }, { reason: 'model' },
        { booking_id: 0 }, { booking_id: 1.1 }, { booking_id: '3 OR true' }, { booking_id: Number.MAX_SAFE_INTEGER + 1 },
        { action: 'cancel' }, { action: 'reject', reason: 'time' }, { action: 'reject' }]) {
        const s = setup(); assert.equal((await s.request(fields)).status, 400); assert.equal(s.calls(), 0);
    }
});

test('both rejection reasons are passed unchanged', async () => {
    for (const reason of ['model', 'plans'] as const) {
        const s = setup((...args) => {
            assert.deepEqual(args, [201, 3, 'reject', reason]);
            return Promise.resolve({ ...result, booking: { ...result.booking, status: 'Отменена мастером', reason } });
        });
        assert.equal((await s.request({ action: 'reject', reason })).status, 200);
    }
});

test('SQL errors are sanitized and malformed successful results fail closed', async () => {
    for (const [code, status] of [['PT404',404], ['PT409',409], ['PT422',400], ['23514',500]] as const) {
        const s = setup(() => Promise.reject({ code, message: 'private SQL detail' }));
        const r = await s.request(); assert.equal(r.status, status); assert.ok(!(await r.text()).includes('private SQL'));
    }
    for (const bad of [{ ...result, replayed: undefined }, { ...result, booking: { ...result.booking, booking_id: 4 } }, { ...result, booking: { ...result.booking, status: 'Отменена моделью' } }]) {
        assert.equal((await setup(() => Promise.resolve(bad as DecisionResult)).request()).status, 500);
    }
});

test('method, content type and bounded body', async () => {
    const s = setup();
    assert.equal((await s.handler(new Request('https://example.test', {method: 'GET'}))).status, 405);
    assert.equal((await s.handler(new Request('https://example.test', {method: 'OPTIONS'}))).status, 200);
    assert.equal((await s.request({}, {headers: {'Content-Type':'text/plain'}})).status, 415);
    assert.equal((await s.request({ padding: 'x'.repeat(17000) })).status, 413);
    assert.equal(s.calls(), 0);
});

test('repository makes exactly one server RPC with verified actor and no table writes', async () => {
    let calls = 0;
    const repository = createSupabaseBookingsWriteRepository('https://example.test', 'server-key', (input, init) => {
        calls++; assert.equal(String(input), 'https://example.test/rest/v1/rpc/bb66_decide_booking');
        assert.equal(init?.method, 'POST'); assert.equal(new Headers(init?.headers).get('apikey'), 'server-key');
        assert.deepEqual(JSON.parse(String(init?.body)), {p_master_id:201,p_booking_id:3,p_action:'confirm',p_reason:null});
        return Promise.resolve(Response.json(result));
    });
    assert.deepEqual(await repository.decide(201,3,'confirm',null), result); assert.equal(calls,1);
});

const source = await readFile(new URL('../../../../webapp/js/data/bookings.js', import.meta.url), 'utf8');
const code = source.replace(/^import .*;\n/gm, '')
    .replace('const readClient =', `const APP_CONFIG = {supabase: {url: 'https://example.test', key: 'public-key'}};
const getTelegramInitData = () => 'signed';
const supabase = {from() {throw Error('Forbidden client write');}};
const sendNotification = () => {};
const readClient =`);
const { createBookingsWriteClient } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('client preserves signatures, result and notification UI payload; replay skips notification', async () => {
    for (const action of ['confirm', 'model', 'plans']) {
        let notifications = 0;
        let calls = 0;
        const reason = action === 'confirm' ? null : action;
        const booking = { ...result.booking, status: reason ? 'Отменена мастером' : 'Активна', reason };
        const c = createBookingsWriteClient({url:'https://example.test',key:'public-key',getInitData:()=>signed(),
            fetchImpl: (url: string, init: RequestInit) => {
                assert.equal(url,'https://example.test/functions/v1/bookings-write');
                assert.deepEqual(JSON.parse(String(init.body)), {action:reason?'reject':'confirm',booking_id:3,init_data:signed(),...(reason?{reason}:{})});
                return Promise.resolve(Response.json({ booking, replayed: calls++ > 0 }));
            }, notify: (name: string, payload: unknown) => {
                notifications++; assert.equal(name,'notify-user');
                assert.deepEqual(payload,{type:reason?'booking_rejected':'booking_confirmed',booking_id:3,...(reason?{reason}:{})});
                return Promise.resolve();
            }});
        const run = () => reason ? c.rejectBooking(3,reason) : c.confirmBooking(3);
        assert.deepEqual(await run(),booking); assert.deepEqual(await run(),booking); assert.equal(notifications,1);
    }
});

test('client has no fallback on auth/network/API failures and keeps committed success on notification failure', async () => {
    let notices = 0;
    for (const fetchImpl of [() => Promise.reject(Error('network')), () => Promise.resolve(Response.json({error:{code:'BOOKING_CONFLICT'}},{status:409})), () => Promise.resolve(Response.json({...result,replayed:undefined}))]) {
        const c = createBookingsWriteClient({url:'https://example.test',key:'public',getInitData:()=>signed(),fetchImpl,notify:()=>{notices++;}});
        await assert.rejects(c.confirmBooking(3));
    }
    assert.equal(notices,0);
    const c = createBookingsWriteClient({url:'https://example.test',key:'public',getInitData:()=>signed(),fetchImpl:() => Promise.resolve(Response.json(result)),notify:()=>{throw Error('delivery');}});
    assert.deepEqual(await c.confirmBooking(3),result.booking);
    const original = await readFile(new URL('../../../../webapp/js/data/bookings.js', import.meta.url),'utf8');
    const decisions = original.slice(original.indexOf('// BB-66:'),original.indexOf('export async function cancelBooking'));
    assert.ok(!decisions.includes('.from(')); assert.ok(!decisions.includes('getBooking('));
});

test('model cancellation uses signed actor and accepts only time/other', async () => {
    for (const reason of ['time', 'other'] as const) {
        const s = setup((...args) => {
            assert.deepEqual(args, [201, 3, 'cancel', reason]);
            return Promise.resolve({ ...result, booking: { ...result.booking, user_id: 201, status: 'Отменена моделью', reason } });
        });
        assert.equal((await s.request({ action: 'cancel', reason })).status, 200);
    }
    for (const fields of [{ reason: 'model' }, { reason: 'plans' }, { reason: null },
        { reason: '' }, { reason: 'time', user_id: 101 }, { reason: 'time', model_id: 101 },
        { reason: 'time', master_id: 201 }, { reason: 'time', status: 'Отменена моделью' }]) {
        const s = setup();
        assert.equal((await s.request({ action: 'cancel', ...fields })).status, 400);
        assert.equal(s.calls(), 0);
    }
    for (const init_data of ['bad', signed(86401), signed().replace('Master', 'Other')]) {
        const s = setup();
        assert.equal((await s.request({ action: 'cancel', reason: 'time', init_data })).status, 401);
        assert.equal(s.calls(), 0);
    }
    // Even an invalid repository response must not expose another user's row.
    const s = setup(() => Promise.resolve({ ...result, booking: { ...result.booking, status: 'Отменена моделью', reason: 'time' } }));
    assert.equal((await s.request({ action: 'cancel', reason: 'time' })).status, 500);
});

test('model repository calls only the atomic cancellation RPC', async () => {
    const cancelled: DecisionResult = { ...result, booking: { ...result.booking, status: 'Отменена моделью', reason: 'other' } };
    let calls = 0;
    const r = createSupabaseBookingsWriteRepository('https://example.test', 'server-key', (input, init) => {
        calls++;
        assert.equal(String(input), 'https://example.test/rest/v1/rpc/bb67_cancel_booking');
        assert.deepEqual(JSON.parse(String(init?.body)), { p_user_id: 101, p_booking_id: 3, p_reason: 'other' });
        return Promise.resolve(Response.json(cancelled));
    });
    assert.deepEqual(await r.decide(101, 3, 'cancel', 'other'), cancelled);
    assert.equal(calls, 1);
});

test('model client preserves booking shape, reasons, UI notification and replay suppression', async () => {
    for (const reason of ['time', 'other']) {
        const booking = { ...result.booking, status: 'Отменена моделью', reason };
        let calls = 0, notices = 0;
        const c = createBookingsWriteClient({ url: 'https://example.test', key: 'public', getInitData: () => signed(),
            fetchImpl: (url: string, init: RequestInit) => {
                assert.equal(url, 'https://example.test/functions/v1/bookings-write');
                assert.deepEqual(JSON.parse(String(init.body)), { action: 'cancel', booking_id: 3, reason, init_data: signed() });
                return Promise.resolve(Response.json({ booking, replayed: calls++ > 0 }));
            }, notify: (name: string, payload: unknown) => {
                notices++;
                assert.equal(name, 'notify-master');
                assert.deepEqual(payload, { type: 'model_cancelled', booking_id: 3 });
                return Promise.reject(Error('notification delivery failed'));
            } });
        assert.deepEqual(await c.cancelBooking(3, reason), booking);
        assert.deepEqual(await c.cancelBooking(3, reason), booking);
        assert.equal(notices, 1);
    }
});

test('model cancellation fails closed without direct writes, actor IDs or fallback', async () => {
    let notices = 0;
    for (const fetchImpl of [() => Promise.reject(Error('network')),
        () => Promise.resolve(Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 })),
        () => Promise.resolve(Response.json({ error: { code: 'BOOKING_CONFLICT' } }, { status: 409 })),
        () => Promise.resolve(Response.json({ ...result, replayed: false }))]) {
        const c = createBookingsWriteClient({ url: 'https://example.test', key: 'public', getInitData: () => signed(), fetchImpl,
            notify: () => { notices++; } });
        await assert.rejects(c.cancelBooking(3, 'time'));
    }
    let calls = 0;
    const c = createBookingsWriteClient({ url: 'https://example.test', key: 'public', getInitData: () => '',
        fetchImpl: () => { calls++; }, notify: () => { notices++; } });
    await assert.rejects(c.cancelBooking(3, 'time'));
    assert.equal(calls, 0); assert.equal(notices, 0);
    assert.ok(!source.includes('.from('));
    const wrapper = source.slice(source.indexOf('export async function cancelBooking'));
    assert.ok(wrapper.includes('return await writeClient.cancelBooking(bookingId, reason)'));
    assert.ok(!wrapper.includes('getBooking('));
    assert.ok(!wrapper.includes('getTelegramUserId'));
});

test('existing model records screen cancels pending/active records and reloads archive', async () => {
    const screenSource = await readFile(new URL('../../../../webapp/js/screens/model/records.js', import.meta.url), 'utf8');
    for (const initialStatus of ['Ожидает подтверждения мастера', 'Активна']) {
        let rows = [{ booking_id: 3, status: initialStatus }];
        const cards: { record: { booking_id: number; status: string }; onCancel: ((record: unknown) => void) | null }[] = [];
        const popups: string[] = [];
        const screenState = { modelRecordsMode: 'active' };
        const container = { set innerHTML(_value: string) { cards.length = 0; }, appendChild(card: typeof cards[number]) { cards.push(card); } };
        let pending: Promise<void> | undefined;
        const mocks = {
            getUserBookings: () => Promise.resolve(rows),
            cancelBooking: (id: number, reason: string) => {
                assert.equal(id, 3); assert.equal(reason, 'time');
                rows = [{ booking_id: 3, status: 'Отменена моделью' }];
                return Promise.resolve(rows[0]);
            },
            createRecordCard: (card: typeof cards[number]) => card,
            showSkeleton: () => {}, state: screenState, setModelRecordsMode: () => {},
            getTelegramUserId: () => 101, hapticImpact: () => {},
            showTelegramPopup: (text: string) => popups.push(text),
            openCancelBookingModal: (callback: (reason: string) => Promise<void>) => { pending = callback('time'); },
            document: { getElementById: () => container, querySelector: () => null },
        };
        // Run the unchanged screen with deterministic UI/service dependencies.
        const globalMocks = globalThis as typeof globalThis & { bb67ScreenMocks?: typeof mocks };
        globalMocks.bb67ScreenMocks = mocks;
        const screenCode = `const { ${Object.keys(mocks).join(',')} } = globalThis.bb67ScreenMocks;\n` + screenSource.replace(/^import .*;\n/gm, '');
        try {
            const screen = await import('data:text/javascript;base64,' + Buffer.from(screenCode).toString('base64') + '#' + encodeURIComponent(initialStatus));
            await screen.loadModelRecords();
            assert.equal(cards.length, 1); assert.ok(cards[0].onCancel);
            cards[0].onCancel(cards[0].record);
            await pending;
            assert.deepEqual(popups, ['Запись отменена.']);
            assert.equal(cards.length, 0);
            screenState.modelRecordsMode = 'archive';
            await screen.loadModelRecords();
            assert.equal(cards.length, 1);
            assert.equal(cards[0].record.status, 'Отменена моделью');
            assert.equal(cards[0].onCancel, null);
        } finally { delete globalMocks.bb67ScreenMocks; }
    }
});
