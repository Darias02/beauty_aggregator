import { deepEqual, equal } from 'node:assert/strict';
import { createStore } from '../../telegram-webhook/services.ts';
import { createSupabaseProfileRepository } from '../repository.ts';
import { actor } from './helpers.ts';
import { postgrestMock } from './postgrest_mock.ts';

Deno.test('BB-57 registration and BB-07 edits preserve name and phone in both orders', async () => {
    const database = postgrestMock();
    const store = createStore({
        botToken: '900:test-token',
        botId: 900,
        botUsername: 'BeautyBookingBot',
        webhookSecret: 'test-webhook-secret-with-32-characters',
        webAppUrl: 'https://example.test',
        supabaseUrl: 'https://profile.test',
        adminKey: 'server-only-test-key',
    }, database.fetch);
    const profile = createSupabaseProfileRepository(
        'https://profile.test', 'server-only-test-key', database.fetch,
    );
    // Registration first, then profile editing, then a distinct /start update.
    await store.upsertUser({ user_id: actor.id, name: 'Имя Telegram' });
    database.rows.get(actor.id)!.phone_number = '+79990000000';
    await profile.ensure(actor.id, '@ignored');
    await profile.updateName(actor.id, 'Выбранное имя');
    await store.upsertUser({ user_id: actor.id, name: 'Новое имя Telegram' });
    deepEqual(database.rows.get(actor.id), {
        user_id: actor.id, name: 'Выбранное имя', phone_number: '+79990000000',
    });
    // Profile first, then webhook registration: neither can overwrite the other.
    await profile.ensure(777, 'Из профиля');
    await store.upsertUser({ user_id: 777, name: 'Из Telegram' });
    equal((await profile.get(777))?.name, 'Из профиля');
    // Registration racing with profile ensure wins without losing its phone.
    database.beforeInsert = () => {
        database.rows.set(888, {
            user_id: 888, name: 'Из регистрации', phone_number: '+79991111111',
        });
    };
    deepEqual(await profile.ensure(888, 'Из профиля'), {
        user_id: 888, name: 'Из регистрации',
    });
    equal(database.rows.get(888)?.phone_number, '+79991111111');
});
