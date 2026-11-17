import { deepEqual, equal, match } from 'node:assert/strict';
import { createAvatarHandler } from '../handler.ts';
import { createAvatarRepository } from '../repository.ts';
import { decodeAvatar } from '../image.ts';
import { actor, botToken, now, signInitData } from '../../user-profile/tests/helpers.ts';
import { fixtureBytes } from './fixtures.ts';

function harness() {
    const profile = {
        master_id: actor.id,
        name: 'Имя',
        address: null,
        avatar_url: 'https://avatar.test/old.jpg',
    };
    const objects = new Map<string, Uint8Array>();
    const calls: Request[] = [];
    let failure = '';
    const storageFetch: typeof fetch = async (input, init) => {
        const req = new Request(input, init);
        calls.push(req.clone());
        equal(req.headers.get('apikey'), 'server-only-test-key');
        const url = new URL(req.url);
        if (url.pathname === '/rest/v1/masters') {
            equal(url.searchParams.get('master_id'), `eq.${actor.id}`);
            if (req.method === 'PATCH') {
                const patch = await req.json();
                deepEqual(Object.keys(patch), ['avatar_url']);
                if (failure === 'db') {
                    return Response.json({ code: '42501', message: 'secret' }, { status: 403 });
                }
                equal(url.searchParams.get('avatar_url'), `eq.${profile.avatar_url}`);
                profile.avatar_url = patch.avatar_url;
            }
            return Response.json([{ ...profile }]);
        }
        if (req.method === 'POST') {
            match(
                url.pathname,
                /^\/storage\/v1\/object\/master-avatars\/424242\/[a-f0-9-]{36}\.png$/,
            );
            equal(req.headers.get('x-upsert'), 'false');
            equal(req.headers.get('content-type'), 'image/png');
            if (failure === 'storage') return Response.json({ message: 'secret' }, { status: 400 });
            objects.set(
                url.pathname.split('/master-avatars/')[1],
                new Uint8Array(await req.arrayBuffer()),
            );
            return Response.json({ Key: url.pathname });
        }
        equal(req.method, 'DELETE');
        const { prefixes } = await req.json();
        prefixes.forEach((path: string) => objects.delete(path));
        return Response.json([]);
    };
    const handler = createAvatarHandler({
        env: (name) =>
            ({
                BOT_TOKEN: botToken,
                SUPABASE_URL: 'https://avatar.test',
                SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
            })[name],
        nowSeconds: () => now,
        decodeImage: decodeAvatar,
        createRepository: (url, key) => createAvatarRepository(url, key, storageFetch),
    });
    return {
        profile,
        objects,
        calls,
        handler,
        set failure(value: string) {
            failure = value;
        },
    };
}

Deno.test('Real image → handler → SDK → Storage and DB; failures preserve old avatar', async () => {
    for (const failure of ['', 'storage', 'db', 'mime', 'corrupt']) {
        const h = harness();
        h.failure = failure;
        const form = new FormData();
        form.append('init_data', signInitData());
        const bytes = fixtureBytes('png');
        if (failure === 'corrupt') bytes[46] ^= 255;
        form.append(
            'avatar',
            new File([bytes], '777/forged.jpg', {
                type: failure === 'mime' ? 'image/jpeg' : 'image/png',
            }),
        );
        const response = await h.handler(
            new Request('https://avatar.test/functions/v1/master-avatar', {
                method: 'POST',
                body: form,
            }),
        );
        if (!failure) {
            equal(response.status, 200);
            const { profile } = await response.json();
            equal(profile.master_id, actor.id);
            equal(profile.avatar_url, h.profile.avatar_url);
            equal(h.objects.size, 1);
            deepEqual([...h.objects.values()][0], fixtureBytes('png'));
        } else {
            equal(response.status, ['mime', 'corrupt'].includes(failure) ? 400 : 500);
            equal(h.profile.avatar_url, 'https://avatar.test/old.jpg');
            equal(h.objects.size, 0);
        }
        if (failure === 'mime' || failure === 'corrupt') equal(h.calls.length, 0);
    }
});

Deno.test('Existing screen preserves photo/popups/reset on success and failure; ignores unsafe identity', async () => {
    const h = harness();
    const events = new Map<string, () => Promise<void>>();
    const avatar = {
        style: { backgroundImage: '' },
        textContent: '',
        addEventListener: (key: string, callback: () => Promise<void>) =>
            events.set(`avatar:${key}`, callback),
    };
    let clicks = 0;
    const input = {
        value: 'photo',
        files: [new File([fixtureBytes('png')], 'photo.png', { type: 'image/png' })],
        click: () => {
            clicks++;
        },
        addEventListener: (key: string, callback: () => Promise<void>) =>
            events.set(`input:${key}`, callback),
    };
    const popups: string[] = [];
    const replacements: Record<string, unknown> = {
        window: {
            Telegram: {
                WebApp: { initData: signInitData(), initDataUnsafe: { user: { id: 777 } } },
            },
            supabase: {
                createClient: () => {
                    throw new Error('Client SDK forbidden');
                },
            },
        },
        document: {
            getElementById: (id: string) =>
                id === 'master-profile-avatar'
                    ? avatar
                    : id === 'master-avatar-upload'
                    ? input
                    : null,
            querySelectorAll: () => [],
            querySelector: () => null,
            addEventListener: () => {},
        },
        alert: (message: string) => popups.push(message),
        fetch: (url: string, init: RequestInit) => {
            const req = new Request(url, init);
            equal(req.headers.has('authorization'), false);
            equal(req.headers.get('apikey') === 'server-only-test-key', false);
            if (new URL(url).pathname === '/functions/v1/master-profile') {
                return Promise.resolve(Response.json({ profile: { ...h.profile } }));
            }
            equal(new URL(url).pathname, '/functions/v1/master-avatar');
            return h.handler(req);
        },
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
        const { initMasterProfile, loadMasterProfile } = await import(
            '../../../../webapp/js/screens/master/profile.js'
        );
        initMasterProfile();
        await loadMasterProfile();
        match(avatar.style.backgroundImage, /old.jpg/);
        await events.get('avatar:click')!();
        equal(clicks, 1);
        await events.get('input:change')!();
        equal(popups.at(-1), 'Фото сохранено.');
        equal(input.value, '');
        const saved = avatar.style.backgroundImage;
        match(saved, /424242/);
        h.failure = 'storage';
        input.value = 'another';
        await events.get('input:change')!();
        equal(popups.at(-1), 'Не удалось сохранить фото.');
        equal(input.value, '');
        equal(avatar.style.backgroundImage, saved);
    } finally {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
