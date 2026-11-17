import { createHmac } from 'node:crypto';
import { createProfileHandler } from '../handler.ts';
import type { ProfileRepository } from '../handler.ts';

export const botToken = '123456:test-token-only';
export const now = 1803660000;
export const actor = { id: 424242, first_name: 'Анна', last_name: 'Тест', username: 'anna_test' };

export function signInitData(fields: Record<string, string> = {}, token = botToken) {
    const values = { auth_date: String(now), user: JSON.stringify(actor), ...fields };
    const check = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...values, hash }).toString();
}

export type Row = { user_id: number; name: string; phone_number: string | null };

export function harness(config: Record<string, string | undefined> = {}) {
    const rows = new Map<number, Row>([
        [actor.id, { user_id: actor.id, name: 'Имя из бота', phone_number: '+79990000000' }],
        [777, { user_id: 777, name: 'Чужой профиль', phone_number: '+79991111111' }],
    ]);
    const calls: { operation: string; id: number; name?: string }[] = [];
    const repository: ProfileRepository = {
        get(id) {
            calls.push({ operation: 'get', id });
            return Promise.resolve(rows.get(id) || null);
        },
        ensure(id, name) {
            calls.push({ operation: 'ensure', id, name });
            if (!rows.has(id)) rows.set(id, { user_id: id, name, phone_number: null });
            return Promise.resolve(rows.get(id)!);
        },
        updateName(id, name) {
            calls.push({ operation: 'update', id, name });
            const existing = rows.get(id);
            if (existing) existing.name = name;
            return Promise.resolve(existing || null);
        },
    };
    const env: Record<string, string | undefined> = {
        BOT_TOKEN: botToken,
        SUPABASE_URL: 'https://profile.test',
        SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
        ...config,
    };
    let creations = 0;
    const handler = createProfileHandler({
        env: (key) => env[key],
        nowSeconds: () => now,
        createRepository: () => {
            creations++;
            return repository;
        },
    });
    return {
        rows,
        calls,
        repository,
        handler,
        get creations() {
            return creations;
        },
    };
}

export function request(body: unknown, url = 'https://profile.test/functions/v1/user-profile') {
    return new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
