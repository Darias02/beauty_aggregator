import { deepEqual, equal, rejects } from 'node:assert/strict';
import { createSupabaseProfileRepository } from '../repository.ts';
import { actor } from './helpers.ts';
import { postgrestMock } from './postgrest_mock.ts';

const registered = {
    master_id: actor.id,
    name: 'Из бота',
    phone_number: '+79990000000',
    address: 'Адрес из бота',
    avatar_url: 'https://avatar.test/a.jpg',
};

Deno.test('Supabase SDK: get filters signed identity and projects only profile fields', async () => {
    const mock = postgrestMock([registered]);
    const repo = createSupabaseProfileRepository(
        'https://profile.test',
        'server-only-test-key',
        mock.fetch,
    );
    deepEqual(await repo.get(actor.id), {
        master_id: actor.id,
        name: 'Из бота',
        address: 'Адрес из бота',
        avatar_url: 'https://avatar.test/a.jpg',
    });
    equal(mock.calls.length, 1);
    equal(mock.calls[0].url.searchParams.get('master_id'), `eq.${actor.id}`);
    equal(mock.calls[0].headers.get('authorization'), 'Bearer server-only-test-key');
});

Deno.test('Supabase SDK: ensure existing profile performs no write', async () => {
    const mock = postgrestMock([registered]);
    const repo = createSupabaseProfileRepository(
        'https://profile.test',
        'server-only-test-key',
        mock.fetch,
    );
    await repo.ensure(actor.id, 'Не перезаписывать');
    deepEqual(mock.rows.get(actor.id), registered);
    deepEqual(mock.calls.map((call) => call.method), ['GET']);
});

Deno.test('Supabase SDK: concurrent ensure is insert-only and repeated calls preserve data', async () => {
    const mock = postgrestMock();
    const repo = createSupabaseProfileRepository(
        'https://profile.test',
        'server-only-test-key',
        mock.fetch,
    );
    await Promise.all(Array.from({ length: 3 }, () => repo.ensure(actor.id, '@anna_test')));
    equal(mock.rows.size, 1);
    for (const call of mock.calls.filter((call) => call.method === 'POST')) {
        deepEqual(call.body, { master_id: actor.id, name: '@anna_test' });
    }
    await repo.update(actor.id, { name: 'Изменённое имя' });
    await repo.ensure(actor.id, '@anna_test');
    equal(mock.rows.get(actor.id)?.name, 'Изменённое имя');
});

Deno.test('Supabase SDK: bot insert racing with ensure wins without loss of phone or name', async () => {
    const mock = postgrestMock();
    mock.beforeInsert = () => {
        mock.rows.set(actor.id, { ...registered });
    };
    const repo = createSupabaseProfileRepository(
        'https://profile.test',
        'server-only-test-key',
        mock.fetch,
    );
    deepEqual(await repo.ensure(actor.id, '@anna_test'), {
        master_id: actor.id,
        name: 'Из бота',
        address: 'Адрес из бота',
        avatar_url: 'https://avatar.test/a.jpg',
    });
    deepEqual(mock.rows.get(actor.id), registered);
});

Deno.test('Supabase SDK: PATCH sends only name, filters own id and preserves phone and other users', async () => {
    const other = {
        master_id: 777,
        name: 'Другой',
        phone_number: '+79991111111',
        address: null,
        avatar_url: null,
    };
    const mock = postgrestMock([registered, other]);
    const repo = createSupabaseProfileRepository(
        'https://profile.test',
        'server-only-test-key',
        mock.fetch,
    );
    deepEqual(await repo.update(actor.id, { name: 'Новое имя' }), {
        master_id: actor.id,
        name: 'Новое имя',
        address: 'Адрес из бота',
        avatar_url: 'https://avatar.test/a.jpg',
    });
    deepEqual(mock.calls[0].body, { name: 'Новое имя' });
    equal(mock.rows.get(actor.id)?.phone_number, registered.phone_number);
    deepEqual(mock.rows.get(777), other);
    equal(await repo.update(888, { name: 'Нет профиля' }), null);
    equal(mock.rows.has(888), false);
});

for (const method of ['GET', 'POST', 'PATCH']) {
    Deno.test(`Supabase SDK: propagates ${method} failures to handler boundary`, async () => {
        const mock = postgrestMock(method === 'POST' ? [] : [registered]);
        mock.failMethod = method;
        const repo = createSupabaseProfileRepository(
            'https://profile.test',
            'server-only-test-key',
            mock.fetch,
        );
        await rejects(() =>
            method === 'GET'
                ? repo.get(actor.id)
                : method === 'POST'
                ? repo.ensure(actor.id, 'Имя')
                : repo.update(actor.id, { name: 'Имя' })
        );
    });
}
