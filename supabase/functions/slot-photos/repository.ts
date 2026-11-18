import { createClient } from '@supabase/supabase-js';

export function createPhotoRepository(url: string, key: string, fetchImpl: typeof fetch = fetch) {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: fetchImpl },
    });
    const bucket = admin.storage.from('slot-photos');
    async function write(
        actor: number,
        slot: number,
        photo: string,
        action: string,
    ) {
        const { data, error } = await admin.rpc('slot_photos_write', {
            p_actor: actor,
            p_slot: slot,
            p_photo: photo,
            p_action: action,
        });
        if (error) throw error;
        if (!data || typeof data.object_path !== 'string') {
            throw new Error('Invalid photo result');
        }
        return data;
    }
    return {
        write,
        async list(actor: number, slot: number) {
            const { data, error } = await admin.rpc('slot_photos_list', {
                p_actor: actor,
                p_slot: slot,
            });
            if (error) throw error;
            if (!Array.isArray(data)) throw new Error('Invalid photos');
            const pending = data.filter((photo) => photo.state === 'pending').map((
                photo,
            ) => photo.photo_id);
            const photos = await Promise.all(
                data.filter((photo) => photo.state === 'ready').map(async (photo) => {
                    const { data: signed, error } = await bucket.createSignedUrl(
                        photo.object_path,
                        3600,
                    );
                    if (error) throw error;
                    return {
                        photo_id: photo.photo_id,
                        url: signed.signedUrl,
                        expires_at: Date.now() + 3600000,
                    };
                }),
            );
            return { photos, pending };
        },
        async upload(path: string, bytes: Uint8Array) {
            const { error } = await bucket.upload(path, bytes, {
                contentType: 'image/jpeg',
                upsert: false,
            });
            if (error && error.statusCode !== '409') throw error;
        },
        async remove(photo: { photo_id: string; object_path: string }) {
            const { error } = await bucket.remove([photo.object_path]);
            if (error) throw error;
            const { error: dbError } = await admin.from('slot_photos').update({
                last_cleanup_at: new Date().toISOString(),
            }).eq('photo_id', photo.photo_id).eq('state', 'deleting');
            if (dbError) throw dbError;
        },
    };
}
