import { deepEqual, equal, match, rejects } from 'node:assert/strict';
// The unchanged avatar path uses the browser Supabase client. Fail if profile code touches it.
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
        supabase: {
            createClient: () => ({
                from: () => {
                    throw new Error('Direct table access');
                },
            }),
        },
    },
});
const { createMasterProfileClient: createProfileClient, MasterProfileApiError: ProfileApiError } =
    await import('../../../../webapp/js/data/masters.js');
Reflect.deleteProperty(globalThis, 'window');
import { createProfileHandler } from '../handler.ts';
import { createSupabaseProfileRepository } from '../repository.ts';
import { actor, botToken, now, signInitData } from './helpers.ts';
import { postgrestMock } from './postgrest_mock.ts';

Deno.test('Client → handler → Supabase SDK → PostgREST: complete own profile flow', async () => {
    const database = postgrestMock();
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
    const requests: { body: Record<string, unknown>; headers: Headers }[] = [];
    const client = createProfileClient({
        url: 'https://profile.test',
        key: 'publishable-test-key',
        getInitData: () => signInitData(),
        fetchImpl: async (url, init) => {
            const req = new Request(url, init);
            requests.push({ body: await req.clone().json(), headers: req.headers });
            equal(init?.cache, 'no-store');
            equal(init?.redirect, 'error');
            equal(init?.credentials, 'omit');
            return handler(req);
        },
    });
    deepEqual(await client.ensureOwnProfile(), {
        master_id: actor.id,
        name: '@anna_test',
        address: null,
        avatar_url: null,
    });
    database.rows.get(actor.id)!.phone_number = '+79990000000';
    deepEqual(await client.updateOwnProfileName('  Новое имя  '), {
        master_id: actor.id,
        name: 'Новое имя',
        address: null,
        avatar_url: null,
    });
    deepEqual(await client.getOwnProfile(), {
        master_id: actor.id,
        name: 'Новое имя',
        address: null,
        avatar_url: null,
    });
    deepEqual(await client.ensureOwnProfile(), {
        master_id: actor.id,
        name: 'Новое имя',
        address: null,
        avatar_url: null,
    });
    equal(database.rows.get(actor.id)?.phone_number, '+79990000000');
    const address = await client.updateOwnProfileAddress('  Москва  ');
    equal(address.address, 'Москва');
    equal(address.name, 'Новое имя');
    equal((await client.updateOwnProfileAddress('')).address, '');
    for (const req of requests) {
        equal(req.headers.get('apikey'), 'publishable-test-key');
        equal(req.headers.has('authorization'), false);
        equal('master_id' in req.body, false);
        equal('phone_number' in req.body, false);
    }
});

Deno.test('Client: missing initData blocks every action without fetch or unsafe fallback', async () => {
    let calls = 0;
    const client = createProfileClient({
        url: 'https://profile.test',
        key: 'public',
        getInitData: () => '',
        fetchImpl: () => {
            calls++;
            throw new Error('Must not fetch');
        },
    });
    for (
        const action of [
            client.getOwnProfile,
            client.ensureOwnProfile,
            () => client.updateOwnProfileName('Имя'),
        ]
    ) {
        await rejects(action, (error: unknown) => {
            equal(error instanceof ProfileApiError, true);
            match((error as Error).message, /Telegram/);
            return true;
        });
    }
    equal(calls, 0);
});

for (
    const [status, code] of [
        [400, 'INVALID_NAME'],
        [400, 'INVALID_ADDRESS'],
        [401, 'UNAUTHORIZED'],
        [404, 'PROFILE_NOT_FOUND'],
        [500, 'PROFILE_UNAVAILABLE'],
        [503, 'SERVER_NOT_CONFIGURED'],
    ] as const
) {
    Deno.test(`Client: maps ${status} ${code} without reflecting sensitive server text`, async () => {
        let calls = 0;
        const client = createProfileClient({
            url: 'https://profile.test',
            key: 'public',
            getInitData: () => 'signed-data',
            fetchImpl: () => {
                calls++;
                return Promise.resolve(
                    Response.json({ error: { code, message: 'server-only-test-key' } }, { status }),
                );
            },
        });
        await rejects(client.getOwnProfile, (error: unknown) => {
            equal((error as InstanceType<typeof ProfileApiError>).code, code);
            equal((error as Error).message.includes('server-only-test-key'), false);
            return true;
        });
        equal(calls, 1);
    });
}

for (
    const response of [
        () => new Response('<html>not deployed</html>', { status: 404 }),
        () =>
            Response.json({ error: { code: 'UNKNOWN', message: 'Sensitive text' } }, {
                status: 400,
            }),
        () => Response.json({ profile: null }),
        () => Response.json({ profile: { master_id: '424242', name: 'Имя' } }),
        () => Response.json({ profile: { master_id: -1, name: 'Имя' } }),
        () => Response.json({ profile: { master_id: actor.id, name: null } }),
    ]
) {
    Deno.test(`Client: handles unavailable function or malformed response ${response().status} ${response().headers.get('content-type')}`, async () => {
        const client = createProfileClient({
            url: 'https://profile.test',
            key: 'public',
            getInitData: () => 'signed',
            fetchImpl: () => Promise.resolve(response()),
        });
        await rejects(client.getOwnProfile, ProfileApiError);
    });
}

Deno.test('Client: network error is sanitized and does not trigger retries or fallback', async () => {
    let calls = 0;
    const client = createProfileClient({
        url: 'https://profile.test',
        key: 'public',
        getInitData: () => 'signed',
        fetchImpl: () => {
            calls++;
            throw new Error('Network secret');
        },
    });
    await rejects(client.getOwnProfile, (error: unknown) => {
        equal((error as Error).message.includes('Network secret'), false);
        return true;
    });
    equal(calls, 1);
});

Deno.test('Client: strips unexpected successful response fields', async () => {
    const client = createProfileClient({
        url: 'https://profile.test',
        key: 'public',
        getInitData: () => 'signed',
        fetchImpl: () =>
            Promise.resolve(
                Response.json({
                    profile: {
                        master_id: actor.id,
                        name: 'Имя',
                        address: null,
                        avatar_url: null,
                        phone_number: '+123',
                        secret: 'private',
                    },
                }),
            ),
    });
    deepEqual(await client.getOwnProfile(), {
        master_id: actor.id,
        name: 'Имя',
        address: null,
        avatar_url: null,
    });
});
