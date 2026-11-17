import { createClient } from '@supabase/supabase-js';
import type { AvatarRepository } from './handler.ts';

const columns = 'master_id,name,address,avatar_url';

export function createAvatarRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
    publicOrigin?: string,
): AvatarRepository {
    const origin = publicOrigin === undefined ? undefined : new URL(publicOrigin);
    if (origin && (
        origin.origin !== publicOrigin?.replace(/\/$/, '') ||
        (origin.protocol !== 'https:' && !(origin.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
    )) throw new Error('Invalid avatar public origin');
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });
    const bucket = admin.storage.from('master-avatars');
    return {
        async get(id) {
            const { data, error } = await admin.from('masters').select(columns)
                .eq('master_id', id).maybeSingle();
            if (error) throw error;
            return data;
        },
        async upload(path, image) {
            const { error } = await bucket.upload(path, image.bytes, {
                upsert: false,
                contentType: image.mime,
                cacheControl: '3600',
            });
            if (error) throw error;
            const publicUrl = new URL(bucket.getPublicUrl(path).data.publicUrl);
            if (origin) {
                // The local runtime reaches Storage through kong, while browsers use localhost.
                publicUrl.protocol = origin.protocol;
                publicUrl.host = origin.host;
            }
            return publicUrl.href;
        },
        async replace(id, previous, next) {
            try {
                let query = admin.from('masters').update({ avatar_url: next }).eq('master_id', id);
                query = previous === null
                    ? query.is('avatar_url', null)
                    : query.eq('avatar_url', previous);
                const { data, error, status } = await query.select(columns).maybeSingle();
                if (error) {
                    // Transport failures and 5xx responses can hide a committed update.
                    return { outcome: status >= 400 && status < 500 ? 'rejected' : 'unknown' };
                }
                return data ? { outcome: 'updated', profile: data } : { outcome: 'rejected' };
            } catch {
                return { outcome: 'unknown' };
            }
        },
        async remove(path) {
            const { error } = await bucket.remove([path]);
            if (error) throw error;
        },
    };
}
