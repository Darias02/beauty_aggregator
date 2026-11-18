import { deepEqual, equal } from 'node:assert/strict';
import { actor, harness, signInitData } from './helpers.ts';

Deno.test('Master screen: own data, editing, cancellation, API failures and avatar compatibility', async () => {
    const h = harness();
    const events = new Map<string, () => Promise<void>>();
    const name = {
        textContent: 'Никнейм',
        dataset: { edited: 'false' },
        addEventListener: (event: string, fn: () => Promise<void>) =>
            events.set(`name:${event}`, fn),
    };
    const address = {
        value: '',
        before: () => {},
        setAttribute: () => {},
        removeAttribute: () => {},
        addEventListener: (event: string, fn: () => Promise<void>) =>
            events.set(`address:${event}`, fn),
    };
    let nextName: string | null = 'Новое имя';
    let failed = false;
    let requests = 0;
    const popups: string[] = [];
    const webApp = {
        initData: signInitData(),
        initDataUnsafe: { user: { id: 777, username: 'attacker' } },
    };
    const replacements: Record<string, unknown> = {
        prompt: () => nextName,
        window: {
            Telegram: { WebApp: webApp },
            prompt: () => nextName,
            supabase: {
                createClient: () => ({
                    from: () => {
                        throw new Error('Direct table access');
                    },
                }),
            },
        },
        document: {
            createElement: () => ({ setAttribute: () => {}, append: () => {}, replaceChildren: () => {} }),
            getElementById: (id: string) =>
                id === 'master-profile-name'
                    ? name
                    : id === 'master-address-input'
                    ? address
                    : null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
        },
        alert: (message: string) => popups.push(message),
        fetch: async (url: string, init: RequestInit) => {
            requests++;
            equal(new URL(url).pathname, '/functions/v1/master-profile');
            const req = new Request(url, init);
            const body = await req.clone().json();
            equal('master_id' in body, false);
            return failed
                ? Response.json({ error: { code: 'PROFILE_UNAVAILABLE' } }, { status: 500 })
                : h.handler(req);
        },
    };
    const descriptors = new Map(
        Object.keys(replacements).map(
            (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
        ),
    );
    const oldError = console.error;
    try {
        for (const [key, value] of Object.entries(replacements)) {
            Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
        }
        console.error = () => {};
        const { initMasterProfile, loadMasterProfile } = await import(
            '../../../../webapp/js/screens/master/profile.js'
        );
        initMasterProfile();
        await loadMasterProfile();
        const { getMaster, ensureMaster } = await import('../../../../webapp/js/data/masters.js');
        equal((await getMaster(777)).master_id, actor.id);
        equal((await ensureMaster(777)).master_id, actor.id);
        equal(name.textContent, 'Имя из бота');
        equal(address.value, 'Адрес из бота');
        await events.get('name:click')!();
        equal(name.textContent, 'Новое имя');
        address.value = '  Новый адрес  ';
        await events.get('address:blur')!();
        equal(h.rows.get(actor.id)?.address, 'Новый адрес');
        equal(h.rows.get(actor.id)?.phone_number, '+79990000000');
        equal(h.rows.get(actor.id)?.avatar_url, 'https://avatar.test/a.jpg');
        const before = requests;
        nextName = null;
        await events.get('name:click')!();
        equal(requests, before);
        failed = true;
        nextName = 'Не сохранится';
        await events.get('name:click')!();
        equal(name.textContent, 'Новое имя');
        address.value = 'Не сохранится';
        await events.get('address:blur')!();
        equal(popups.at(-1), 'Не удалось сохранить адрес.');
        await loadMasterProfile();
        equal(name.textContent, 'Не удалось загрузить или сохранить профиль. Попробуйте позже.');
        equal(name.dataset.edited, 'false');
        equal(h.rows.get(actor.id)?.name, 'Новое имя');
        failed = false;
        webApp.initData = '';
        const beforeMissingAuth = requests;
        await loadMasterProfile();
        equal(requests, beforeMissingAuth);
        webApp.initData = signInitData();
        await loadMasterProfile();
        equal(name.textContent, 'Новое имя');
        deepEqual(h.rows.get(777), {
            master_id: 777,
            name: 'Чужой профиль',
            phone_number: '+79991111111',
            address: null,
            avatar_url: null,
        });
    } finally {
        console.error = oldError;
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
