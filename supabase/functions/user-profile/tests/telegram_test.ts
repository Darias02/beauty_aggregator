import { deepEqual, equal } from 'node:assert/strict';
import { getAdminKey, validateInitData } from '../../_shared/telegram.ts';
import { actor, botToken, now, signInitData } from './helpers.ts';

Deno.test('Telegram: independent fixed HMAC fixture with Unicode and form encoding', async () => {
    const fixture =
        'auth_date=1803660000&query_id=test-query&user=%7B%22id%22%3A424242%2C%22first_name%22%3A%22%D0%90%D0%BD%D0%BD%D0%B0%22%2C%22last_name%22%3A%22%D0%A2%D0%B5%D1%81%D1%82%22%2C%22username%22%3A%22anna_test%22%7D&hash=d7a4e4aa97d7afd72f293bff669bc8f1af9bab19e37071370f3e21ae29be9f7c';
    deepEqual(await validateInitData(fixture, botToken, { nowSeconds: now }), actor);
});

Deno.test('Telegram: valid signature, reordered fields and additional Telegram signature field', async () => {
    const signed = signInitData({ signature: 'telegram-ed25519-signature', query_id: 'a+b & c' });
    const reordered = signed.split('&').reverse().join('&');
    deepEqual(await validateInitData(reordered, botToken, { nowSeconds: now }), actor);
});

const invalidData = [
    ['missing data', ''],
    ['malformed hash', 'auth_date=1803660000&hash=hello'],
    ['tampered user', signInitData().replace('424242', '777777')],
    ['wrong bot token', signInitData({}, 'different-token')],
    ['expired', signInitData({ auth_date: String(now - 86401) })],
    ['future', signInitData({ auth_date: String(now + 1) })],
    ['missing date', signInitData({ auth_date: '' })],
    ['fractional date', signInitData({ auth_date: `${now}.5` })],
    ['exponent date', signInitData({ auth_date: '1.80366e9' })],
    ['unsafe date', signInitData({ auth_date: '999999999999999999' })],
    ['duplicate date', `${signInitData()}&auth_date=${now}`],
    ['duplicate hash', `${signInitData()}&hash=${'0'.repeat(64)}`],
    ['duplicate user', `${signInitData()}&user=%7B%22id%22%3A777%7D`],
    ['encoded duplicate user', `${signInitData()}&%75ser=x`],
    ['invalid percent escape', `${signInitData()}&start_param=%XY`],
    ['invalid UTF8', `${signInitData()}&start_param=%FF`],
    ['invalid pair', `${signInitData()}&broken`],
    ['empty key', `${signInitData()}&=value`],
    ['newline key', signInitData({ 'bad\nkey': 'value' })],
    ['newline value', signInitData({ start_param: 'a\nb' })],
    ['missing user', signInitData({ user: '' })],
    ['invalid user JSON', signInitData({ user: '{' })],
    ['null user', signInitData({ user: 'null' })],
    ['array user', signInitData({ user: '[]' })],
    ['oversized data', 'x'.repeat(8193)],
];
for (const [label, data] of invalidData) {
    Deno.test(`Telegram: rejects ${label}`, async () => {
        equal(await validateInitData(data, botToken, { nowSeconds: now }), null);
    });
}

for (const id of [0, -1, 1.2, '424242', null, true, 9007199254740992]) {
    Deno.test(`Telegram: rejects invalid signed user id ${String(id)}`, async () => {
        equal(
            await validateInitData(
                signInitData({ user: JSON.stringify({ ...actor, id }) }),
                botToken,
                { nowSeconds: now },
            ),
            null,
        );
    });
}

for (
    const user of [{ id: 42 }, { ...actor, username: 42 }, {
        ...actor,
        last_name: [],
    }]
) {
    Deno.test(`Telegram: rejects invalid signed user structure ${JSON.stringify(user)}`, async () => {
        equal(
            await validateInitData(signInitData({ user: JSON.stringify(user) }), botToken, {
                nowSeconds: now,
            }),
            null,
        );
    });
}

Deno.test('Telegram: freshness boundaries and configurable shorter TTL', async () => {
    for (const seconds of [now - 86400, now]) {
        deepEqual(
            await validateInitData(signInitData({ auth_date: String(seconds) }), botToken, {
                nowSeconds: now,
            }),
            actor,
        );
    }
    equal(
        await validateInitData(signInitData({ auth_date: String(now - 301) }), botToken, {
            nowSeconds: now,
            maxAgeSeconds: 300,
        }),
        null,
    );
    equal(await validateInitData(signInitData(), '', { nowSeconds: now }), null);
    equal(await validateInitData(signInitData(), botToken, { nowSeconds: NaN }), null);
});

Deno.test('Server key: new named default and legacy key compatibility', () => {
    equal(
        getAdminKey((key) =>
            ({
                SUPABASE_SECRET_KEYS: '{"default":"new-server-key"}',
                SUPABASE_SERVICE_ROLE_KEY: 'legacy-key',
            })[key]
        ),
        'new-server-key',
    );
    equal(
        getAdminKey((key) => key === 'SUPABASE_SERVICE_ROLE_KEY' ? 'legacy-key' : undefined),
        'legacy-key',
    );
    equal(getAdminKey(() => undefined), '');
});

Deno.test('Telegram: preserves BB-06 empty first_name notification contract', async () => {
    const user = { ...actor, first_name: '' };
    deepEqual(await validateInitData(signInitData({ user: JSON.stringify(user) }), botToken, {
        nowSeconds: now,
    }), user);
});
