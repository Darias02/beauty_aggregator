import { createProfileHandler } from '../handler.ts';
import type { ProfileRepository } from '../handler.ts';

import { actor, botToken, now } from '../../user-profile/tests/helpers.ts';
export { actor, botToken, now, signInitData } from '../../user-profile/tests/helpers.ts';

export type Row = {
    master_id: number;
    name: string;
    phone_number: string | null;
    address: string | null;
    avatar_url: string | null;
};

export function harness(config: Record<string, string | undefined> = {}) {
    const rows = new Map<number, Row>([
        [actor.id, {
            master_id: actor.id,
            name: 'Имя из бота',
            phone_number: '+79990000000',
            address: 'Адрес из бота',
            avatar_url: 'https://avatar.test/a.jpg',
        }],
        [777, {
            master_id: 777,
            name: 'Чужой профиль',
            phone_number: '+79991111111',
            address: null,
            avatar_url: null,
        }],
    ]);
    const calls: { operation: string; id: number; patch?: unknown; name?: string }[] = [];
    const repository: ProfileRepository = {
        get(id) {
            calls.push({ operation: 'get', id });
            return Promise.resolve(rows.get(id) || null);
        },
        ensure(id, name) {
            calls.push({ operation: 'ensure', id, name });
            if (!rows.has(id)) {
                rows.set(id, {
                    master_id: id,
                    name,
                    phone_number: null,
                    address: null,
                    avatar_url: null,
                });
            }
            return Promise.resolve(rows.get(id)!);
        },
        update(id, patch) {
            calls.push({ operation: 'update', id, patch });
            const existing = rows.get(id);
            if (existing) Object.assign(existing, patch);
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

export function request(body: unknown, url = 'https://profile.test/functions/v1/master-profile') {
    return new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
