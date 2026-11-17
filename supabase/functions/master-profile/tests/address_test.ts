import { deepEqual, equal } from 'node:assert/strict';
import { actor, harness, request, signInitData } from './helpers.ts';
import { createSupabaseProfileRepository } from '../repository.ts';
import { postgrestMock } from './postgrest_mock.ts';

for (const address of [null, 42, false, [], {}, 'A'.repeat(501), '\nАдрес', 'Адрес\u202e']) {
    Deno.test(`Master profile rejects invalid address ${JSON.stringify(address)}`, async () => {
        const h = harness();
        const response = await h.handler(
            request({ action: 'update', init_data: signInitData(), profile: { address } }),
        );
        equal(response.status, 400);
        equal((await response.json()).error.code, 'INVALID_ADDRESS');
        equal(h.creations, 0);
    });
}

Deno.test('Master address: trim, clear, Unicode bound and atomic name/address validation', async () => {
    const h = harness();
    const original = { ...h.rows.get(actor.id)! };
    for (const address of ['  Москва, дом 1  ', '', '🌸'.repeat(500)]) {
        const response = await h.handler(
            request({ action: 'update', init_data: signInitData(), profile: { address } }),
        );
        equal(response.status, 200);
        equal((await response.json()).profile.address, address.trim());
        deepEqual(h.rows.get(actor.id), { ...original, address: address.trim() });
    }
    const before = { ...h.rows.get(actor.id)! };
    equal(
        (await h.handler(
            request({
                action: 'update',
                init_data: signInitData(),
                profile: { name: 'Не сохранять', address: 42 },
            }),
        )).status,
        400,
    );
    deepEqual(h.rows.get(actor.id), before);
});

for (const action of ['get', 'ensure', 'update']) {
    for (const field of ['master_id', 'user_id', 'id', 'phone_number', 'avatar_url']) {
        Deno.test(`Master profile rejects ${field} in ${action}`, async () => {
            const h = harness();
            const before = [...h.rows.values()].map((row) => ({ ...row }));
            const body = {
                action,
                init_data: signInitData(),
                ...(action === 'update'
                    ? { profile: { name: 'X', [field]: 777 } }
                    : { [field]: 777 }),
            };
            equal((await h.handler(request(body))).status, 400);
            equal(h.creations, 0);
            deepEqual([...h.rows.values()], before);
        });
    }
}

Deno.test('Another valid Telegram actor can only read and update their own row', async () => {
    const h = harness();
    const original = { ...h.rows.get(actor.id)! };
    const init_data = signInitData({ user: JSON.stringify({ id: 777, first_name: 'Другой' }) });
    const read = await h.handler(request({ action: 'get', init_data }));
    equal((await read.json()).profile.master_id, 777);
    const update = await h.handler(
        request({
            action: 'update',
            init_data,
            profile: { name: 'Своё имя', address: 'Свой адрес' },
        }),
    );
    equal(update.status, 200);
    deepEqual(h.rows.get(actor.id), original);
    equal(h.rows.get(777)?.address, 'Свой адрес');
});

Deno.test('Supabase SDK: address patch filters identity and preserves protected fields', async () => {
    const registered = {
        master_id: actor.id,
        name: 'Имя',
        address: 'Адрес',
        avatar_url: 'https://avatar.test/a.jpg',
        phone_number: '+79990000000',
    };
    const mock = postgrestMock([registered]);
    const repo = createSupabaseProfileRepository(
        'https://profile.test',
        'server-only-test-key',
        mock.fetch,
    );
    await repo.update(actor.id, { address: '' });
    deepEqual(mock.calls[0].body, { address: '' });
    equal(mock.calls[0].url.searchParams.get('master_id'), `eq.${actor.id}`);
    deepEqual(mock.rows.get(actor.id), { ...registered, address: '' });
    await repo.ensure(actor.id, 'Не перезаписывать');
    deepEqual(mock.rows.get(actor.id), { ...registered, address: '' });
});
