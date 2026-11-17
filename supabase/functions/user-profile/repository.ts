import { createClient } from '@supabase/supabase-js';
import type { Profile, ProfileRepository } from './handler.ts';

const columns = 'user_id,name';

export function createSupabaseProfileRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
): ProfileRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });

    async function get(userId: number): Promise<Profile | null> {
        const { data, error } = await admin.from('users').select(columns)
            .eq('user_id', userId).maybeSingle();
        if (error) throw error;
        return data;
    }

    return {
        get,
        async ensure(userId, name) {
            const existing = await get(userId);
            if (existing) return existing;
            const { error } = await admin.from('users').upsert({ user_id: userId, name }, {
                onConflict: 'user_id',
                ignoreDuplicates: true,
            });
            if (error) throw error;
            const profile = await get(userId);
            if (!profile) throw new Error('Profile creation failed');
            return profile;
        },
        async updateName(userId, name) {
            const { data, error } = await admin.from('users').update({ name })
                .eq('user_id', userId).select(columns).maybeSingle();
            if (error) throw error;
            return data;
        },
    };
}
