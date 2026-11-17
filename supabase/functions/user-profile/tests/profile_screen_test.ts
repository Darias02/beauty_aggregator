import { deepEqual, equal, match } from 'node:assert/strict';
import { initModelProfile, loadModelProfile } from '../../../../webapp/js/screens/model/profile.js';
import { state } from '../../../../webapp/js/state.js';
import { actor, botToken, now, signInitData } from './helpers.ts';
import { createProfileHandler } from '../handler.ts';
import { createSupabaseProfileRepository } from '../repository.ts';
import { postgrestMock } from './postgrest_mock.ts';

Deno.test('Profile screen: verified profile, editing, retries and expired/missing auth', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const name = {
        textContent: 'Никнейм',
        dataset: { edited: 'false' },
        addEventListener: (event: string, listener: () => Promise<void>) => {
            listeners.set(event, listener);
        },
    };
    const database = postgrestMock([{
        user_id: actor.id,
        name: 'Профиль из бота',
        phone_number: '+79990000000',
    }]);
    const env: Record<string, string> = {
        BOT_TOKEN: botToken,
        SUPABASE_URL: 'https://profile.test',
        SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
    };
    const handler = createProfileHandler({
        env: (key) => env[key],
        nowSeconds: () => now,
        createRepository: (url, key) => createSupabaseProfileRepository(url, key, database.fetch),
    });
    const webApp = {
        initData: signInitData(),
        initDataUnsafe: { user: { id: 777, username: 'attacker' } },
    };
    const popups: string[] = [];
    let nextName: string | null = 'Новое имя';
    let calls = 0;
    let status = 200;
    const replacements: Record<string, unknown> = {
        window: { Telegram: { WebApp: webApp } },
        document: {
            getElementById: (id: string) => id === 'model-profile-name' ? name : null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
        },
        prompt: () => nextName,
        alert: (message: string) => {
            popups.push(message);
        },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls++;
            if (status !== 200) {
                return Response.json({
                    error: { code: status === 401 ? 'UNAUTHORIZED' : 'PROFILE_UNAVAILABLE' },
                }, { status });
            }
            const req = new Request(input, init);
            const body = await req.clone().json();
            equal('user_id' in body, false);
            return handler(req);
        }) as typeof fetch,
    };
    const descriptors = new Map(
        Object.keys(replacements).map((
            key,
        ) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    try {
        for (const [key, value] of Object.entries(replacements)) {
            Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        }
        initModelProfile();
        await loadModelProfile();
        equal(name.textContent, 'Профиль из бота');
        equal(name.dataset.edited, 'true');
        deepEqual(state.user, { user_id: actor.id, name: 'Профиль из бота' });
        equal(calls, 1);

        await listeners.get('click')!();
        equal(name.textContent, 'Новое имя');
        equal(database.rows.get(actor.id)?.phone_number, '+79990000000');
        equal(database.rows.has(777), false);

        nextName = null;
        const callsBeforeCancel = calls;
        await listeners.get('click')!();
        equal(calls, callsBeforeCancel);

        nextName = 'Другое имя';
        status = 500;
        await listeners.get('click')!();
        equal(name.textContent, 'Новое имя');
        equal(popups.length, 1);

        status = 401;
        await listeners.get('click')!();
        match(name.textContent, /Telegram/);
        equal(state.user, null);
        equal(name.dataset.edited, 'false');

        status = 200;
        await listeners.get('click')!();
        equal(name.textContent, 'Новое имя');
        webApp.initData = '';
        const callsBeforeMissingAuth = calls;
        await loadModelProfile();
        match(name.textContent, /Telegram/);
        equal(state.user, null);
        equal(calls, callsBeforeMissingAuth);

        webApp.initData = signInitData();
        status = 500;
        await loadModelProfile();
        match(name.textContent, /Не удалось/);
        equal(state.user, null);
        status = 200;
        await loadModelProfile();
        equal(name.textContent, 'Новое имя');
    } finally {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
