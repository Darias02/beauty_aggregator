import { createClient } from '@supabase/supabase-js';
import type { Profile, ProfileRepository } from './handler.ts';

const columns = 'master_id,name,address,avatar_url';

export function createSupabaseProfileRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
): ProfileRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });

    async function get(masterId: number): Promise<Profile | null> {
        const { data, error } = await admin.from('masters').select(columns)
            .eq('master_id', masterId).maybeSingle();
        if (error) throw error;
        return data;
    }

    return {
        get,
        async ensure(masterId, name) {
            const existing = await get(masterId);
            if (existing) return existing;
            const { error } = await admin.from('masters').upsert({ master_id: masterId, name }, {
                onConflict: 'master_id',
                ignoreDuplicates: true,
            });
            if (error) throw error;
            const profile = await get(masterId);
            if (!profile) throw new Error('Profile creation failed');
            return profile;
        },
        async update(masterId, patch) {
            const { data, error } = await admin.from('masters').update(patch)
                .eq('master_id', masterId).select(columns).maybeSingle();
            if (error) throw error;
            return data;
        },
    };
}
