import { equal, match } from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AuthClient } from 'npm:@supabase/supabase-js@2.118.0';

type Handler = (req: Request) => Promise<Response>;

Deno.test('notifications preserve signed identity, freshness, ownership and delivery contracts', async () => {
    const originalServe = Deno.serve;
    const originalEnv = Deno.env.get;
    const originalFetch = globalThis.fetch;
    const originalStart = AuthClient.prototype.startAutoRefresh;
    const clients = new Set<InstanceType<typeof AuthClient>>();
    const starts: Promise<void>[] = [];
    let handler: Handler | undefined;
    const token = '900:notification-test-token';
    const env: Record<string, string> = {
        BOT_TOKEN: token,
        SUPABASE_URL: 'https://notifications.test',
        SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
    };
    const sent: { chat_id: number; text: string }[] = [];
    let bookingUser = 42;
    let slotMaster = 77;
    let missingSlot = false;
    let databaseReads = 0;
    const signed = (id: number, age = 0) => {
        const values = {
            auth_date: String(Math.floor(Date.now() / 1000) - age),
            user: JSON.stringify({ id, first_name: 'Тест' }),
        };
        const check = Object.entries(values).sort(([a], [b]) => a < b ? -1 : 1)
            .map(([key, value]) => `${key}=${value}`).join('\n');
        const secret = createHmac('sha256', 'WebAppData').update(token).digest();
        return new URLSearchParams({
            ...values, hash: createHmac('sha256', secret).update(check).digest('hex'),
        }).toString();
    };
    const invoke = (body: Record<string, unknown>, method = 'POST') => handler!(
        new Request('https://notifications.test/function', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? JSON.stringify(body) : undefined,
        }),
    );
    try {
        // Track legacy SDK clients so their refresh timers can be stopped after the test.
        AuthClient.prototype.startAutoRefresh = function () {
            clients.add(this);
            const started = originalStart.call(this);
            starts.push(started);
            return started;
        };
        Object.defineProperty(Deno, 'serve', { value: (value: Handler) => { handler = value; } });
        Deno.env.get = (key) => env[key];
        globalThis.fetch = (input, init) => {
            const url = new URL(String(input));
            if (url.origin === 'https://api.telegram.org') {
                equal(url.pathname, `/bot${token}/sendMessage`);
                sent.push(JSON.parse(String(init?.body)));
                return Promise.resolve(Response.json({ ok: true }));
            }
            equal(url.origin, env.SUPABASE_URL);
            databaseReads++;
            const table = url.pathname.split('/').at(-1);
            const rows = {
                bookings: { booking_id: 1, user_id: bookingUser, slot_id: 2, reason: 'time' },
                slots: missingSlot ? null : {
                    master_id: slotMaster, service_id: 3,
                    date_time: '2026-11-01T10:00:00Z', city: 'Москва', address: 'Адрес',
                },
                services: { name: 'Услуга' },
                users: { name: 'Выбранное имя' },
                masters: { name: 'Мастер' },
            };
            equal(Object.hasOwn(rows, table!), true);
            return Promise.resolve(Response.json(rows[table as keyof typeof rows]));
        };
        await import('../notify-master/index.ts');
        equal(typeof handler, 'function');
        equal((await invoke({}, 'OPTIONS')).status, 200);
        const request = { booking_id: 1, actor_id: 42, type: 'booking_created', init_data: signed(42) };
        equal((await invoke(request)).status, 200);
        equal(sent.length, 1);
        equal(sent[0].chat_id, 77);
        match(sent[0].text, /Выбранное имя/);
        for (const init_data of [signed(42, 86401), signed(42, -60), 'forged']) {
            equal((await invoke({ ...request, init_data })).status, 401);
        }
        equal((await invoke({ ...request, actor_id: 99 })).status, 401);
        bookingUser = 99;
        equal((await invoke(request)).status, 404);
        bookingUser = 42;
        equal(sent.length, 1);
        await import('../notify-user/index.ts');
        const confirm = { booking_id: 1, type: 'booking_confirmed', init_data: signed(77) };
        equal((await invoke(confirm)).status, 200);
        equal(sent.length, 2);
        equal(sent[1].chat_id, 42);
        match(sent[1].text, /Мастер/);
        for (const init_data of ['', signed(77, 86401), signed(77, -60), 'forged']) {
            const before = databaseReads;
            equal((await invoke({ ...confirm, init_data })).status, 401);
            equal(databaseReads, before, 'invalid authorization must not read privileged booking data');
        }
        slotMaster = 99;
        equal((await invoke(confirm)).status, 401);
        missingSlot = true;
        equal((await invoke(confirm)).status, 401);
        equal(sent.length, 2);
    } finally {
        Object.defineProperty(Deno, 'serve', { value: originalServe });
        Deno.env.get = originalEnv;
        globalThis.fetch = originalFetch;
        await Promise.all(starts);
        await Promise.all([...clients].map((client) => client.stopAutoRefresh()));
        AuthClient.prototype.startAutoRefresh = originalStart;
    }
});
