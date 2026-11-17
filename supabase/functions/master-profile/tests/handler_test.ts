import { deepEqual, equal, match } from 'node:assert/strict';
import { actor, harness, now, request, signInitData } from './helpers.ts';

Deno.test('Profile: gets only own public profile fields', async () => {
    const h = harness();
    const response = await h.handler(request({ action: 'get', init_data: signInitData() }));
    equal(response.status, 200);
    deepEqual(await response.json(), {
        profile: {
            master_id: actor.id,
            name: 'Имя из бота',
            address: 'Адрес из бота',
            avatar_url: 'https://avatar.test/a.jpg',
        },
    });
    equal(response.headers.get('cache-control'), 'no-store');
    deepEqual(h.calls, [{ operation: 'get', id: actor.id }]);
});

Deno.test('Profile: updates trimmed name and preserves phone and other users', async () => {
    const h = harness();
    const other = { ...h.rows.get(777)! };
    const response = await h.handler(
        request({
            action: 'update',
            init_data: signInitData(),
            profile: { name: '  Новое имя 🌸  ' },
        }),
    );
    equal(response.status, 200);
    deepEqual(await response.json(), {
        profile: {
            master_id: actor.id,
            name: 'Новое имя 🌸',
            address: 'Адрес из бота',
            avatar_url: 'https://avatar.test/a.jpg',
        },
    });
    equal(h.rows.get(actor.id)?.phone_number, '+79990000000');
    deepEqual(h.rows.get(777), other);
});

Deno.test('Profile: repeated ensure preserves bot registration, custom name and phone', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
        equal(
            (await h.handler(request({ action: 'ensure', init_data: signInitData() }))).status,
            200,
        );
    }
    deepEqual(h.rows.get(actor.id), {
        master_id: actor.id,
        name: 'Имя из бота',
        phone_number: '+79990000000',
        address: 'Адрес из бота',
        avatar_url: 'https://avatar.test/a.jpg',
    });
});

Deno.test('Profile: creates missing row with verified identity and signed name', async () => {
    const h = harness();
    h.rows.delete(actor.id);
    const responses = await Promise.all(
        Array.from(
            { length: 3 },
            () => h.handler(request({ action: 'ensure', init_data: signInitData() })),
        ),
    );
    for (const response of responses) equal(response.status, 200);
    deepEqual(h.rows.get(actor.id), {
        master_id: actor.id,
        name: '@anna_test',
        phone_number: null,
        address: null,
        avatar_url: null,
    });
    equal(h.rows.size, 2);
});

Deno.test('Profile: signed full name fallback is bounded and contains no controls', async () => {
    const h = harness();
    h.rows.delete(actor.id);
    const init_data = signInitData({
        user: JSON.stringify({ id: actor.id, first_name: 'А'.repeat(101), last_name: '\nТест' }),
    });
    equal((await h.handler(request({ action: 'ensure', init_data }))).status, 200);
    equal(h.rows.get(actor.id)?.name, 'А'.repeat(100));
});

for (const action of ['get', 'update']) {
    Deno.test(`Profile: ${action} missing row returns 404 without creating it`, async () => {
        const h = harness();
        h.rows.delete(actor.id);
        const response = await h.handler(
            request({
                action,
                init_data: signInitData(),
                ...(action === 'update' ? { profile: { name: 'Имя' } } : {}),
            }),
        );
        equal(response.status, 404);
        equal(h.rows.has(actor.id), false);
    });
}

const invalidBodies: [string, Record<string, unknown>][] = [
    ['foreign top-level master_id', { action: 'get', master_id: 777 }],
    ['own top-level master_id', { action: 'get', master_id: actor.id }],
    ['foreign nested master_id', { action: 'update', profile: { name: 'X', master_id: 777 } }],
    ['phone update', { action: 'update', profile: { phone_number: '+123' } }],
    ['role update', { action: 'update', profile: { name: 'X', role: 'admin' } }],
    ['name on ensure', { action: 'ensure', name: 'Browser name' }],
    ['patch on get', { action: 'get', profile: { name: 'X' } }],
    ['patch on ensure', { action: 'ensure', profile: { name: 'X' } }],
    ['missing action', {}],
    ['unknown action', { action: 'delete' }],
    ['array action', { action: ['get'] }],
    ['array patch', { action: 'update', profile: [] }],
    ['null patch', { action: 'update', profile: null }],
    ['empty patch', { action: 'update', profile: {} }],
];
for (const [label, body] of invalidBodies) {
    Deno.test(`Profile: rejects ${label} before creating admin client`, async () => {
        const h = harness();
        const response = await h.handler(request({ init_data: signInitData(), ...body }));
        equal(response.status, 400);
        equal(h.creations, 0);
        equal(h.calls.length, 0);
    });
}

for (
    const name of [
        null,
        42,
        true,
        [],
        {},
        '',
        '   ',
        'A'.repeat(101),
        'И\nмя',
        '\tИмя',
        'Имя\u0000',
        '\u202eИмя',
    ]
) {
    Deno.test(`Profile: rejects invalid name ${JSON.stringify(name)}`, async () => {
        const h = harness();
        const response = await h.handler(
            request({ action: 'update', init_data: signInitData(), profile: { name } }),
        );
        equal(response.status, 400);
        equal((await response.json()).error.code, 'INVALID_NAME');
        equal(h.creations, 0);
    });
}

Deno.test('Profile: accepts 100 Unicode code points and repeated updates', async () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
        const response = await h.handler(
            request({
                action: 'update',
                init_data: signInitData(),
                profile: { name: '🌸'.repeat(100) },
            }),
        );
        equal(response.status, 200);
    }
    equal(h.rows.get(actor.id)?.phone_number, '+79990000000');
});

for (
    const init_data of [
        undefined,
        null,
        {},
        '',
        signInitData({}, 'wrong'),
        signInitData().replace('424242', '777777'),
        signInitData({ auth_date: String(now - 86401) }),
    ]
) {
    Deno.test(`Profile: rejects missing or invalid authorization ${String(JSON.stringify(init_data)).slice(0, 35)}`, async () => {
        const h = harness();
        const response = await h.handler(request({ action: 'get', init_data }));
        equal(response.status, 401);
        equal(h.creations, 0);
        equal(h.calls.length, 0);
    });
}

Deno.test('Profile: API key, CORS origin and unsafe Telegram user do not authorize', async () => {
    const h = harness();
    const req = request({ action: 'get', initDataUnsafe: { user: actor }, master_id: actor.id });
    req.headers.set('apikey', 'public-key');
    req.headers.set('authorization', 'Bearer public-key');
    req.headers.set('origin', 'https://trusted-looking.test');
    equal((await h.handler(req)).status, 401);
    equal(h.creations, 0);
});

for (
    const config of [
        { SUPABASE_SERVICE_ROLE_KEY: undefined },
        { SUPABASE_SERVICE_ROLE_KEY: '   ' },
        { SUPABASE_URL: undefined },
        { BOT_TOKEN: undefined },
        { SUPABASE_SECRET_KEYS: '{invalid' },
        { SUPABASE_SECRET_KEYS: 'null' },
        { SUPABASE_SECRET_KEYS: '[]' },
    ]
) {
    Deno.test(`Profile: missing or malformed server configuration ${JSON.stringify(config)}`, async () => {
        const h = harness(config);
        const response = await h.handler(request({ action: 'get', init_data: signInitData() }));
        equal(response.status, 503);
        equal((await response.json()).error.code, 'SERVER_NOT_CONFIGURED');
        equal(h.creations, 0);
    });
}

for (const operation of ['get', 'ensure', 'update'] as const) {
    Deno.test(`Profile: sanitizes Supabase ${operation} error`, async () => {
        const h = harness();
        h.repository[operation] = () => {
            throw new Error('server-only-test-key +79990000000 SQL details');
        };
        const action = operation === 'update' ? 'update' : operation;
        const response = await h.handler(
            request({
                action,
                init_data: signInitData(),
                ...(action === 'update' ? { profile: { name: 'X' } } : {}),
            }),
        );
        equal(response.status, 500);
        deepEqual(await response.json(), {
            error: { code: 'PROFILE_UNAVAILABLE', message: 'Profile service is unavailable.' },
        });
    });
}

Deno.test('Profile: rejects a repository response belonging to another user', async () => {
    const h = harness();
    h.repository.get = () =>
        Promise.resolve({ master_id: 777, name: 'Секрет', address: null, avatar_url: null });
    const response = await h.handler(request({ action: 'get', init_data: signInitData() }));
    equal(response.status, 500);
    equal((await response.text()).includes('Секрет'), false);
});

Deno.test('Profile: bounded body, malformed JSON, content type, method and query validation', async () => {
    const h = harness();
    for (
        const [body, expected] of [['{', 400], ['null', 400], ['[]', 400], [
            'x'.repeat(16385),
            413,
        ]] as const
    ) {
        const response = await h.handler(
            new Request('https://profile.test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            }),
        );
        equal(response.status, expected);
    }
    equal(
        (await h.handler(new Request('https://profile.test', { method: 'POST', body: '{}' })))
            .status,
        415,
    );
    equal(
        (await h.handler(
            request(
                { action: 'get', init_data: signInitData() },
                'https://profile.test?master_id=777',
            ),
        )).status,
        400,
    );
    const get = await h.handler(new Request('https://profile.test'));
    equal(get.status, 405);
    match(get.headers.get('allow')!, /POST/);
    const options = await h.handler(new Request('https://profile.test', { method: 'OPTIONS' }));
    equal(options.status, 200);
    equal(options.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    equal(h.creations, 0);
});
