// Explicit server environment only. Default mode is read-only, --apply performs cleanup.
// deno run --config supabase/functions/slot-photos/deno.json --allow-env --allow-net tools/cleanup_slot_photos.ts [--apply]
import { createClient } from '@supabase/supabase-js';
import { getAdminKey } from '../supabase/functions/_shared/telegram.ts';
import { createPhotoRepository } from '../supabase/functions/slot-photos/repository.ts';
const url = Deno.env.get('SUPABASE_URL');
const key = getAdminKey();
if (!url || !key) throw new Error('Server configuration required');
const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
});
if (!Deno.args.includes('--apply')) {
    const { count, error } = await admin.from('slot_photos').select('photo_id', {
        count: 'exact',
        head: true,
    })
        .or(
            `slot_id.is.null,state.eq.deleting,and(state.eq.pending,created_at.lt.${
                new Date(Date.now() - 86400000).toISOString()
            })`,
        );
    if (error) throw new Error('Preview query failed');
    console.info(
        `Read-only preview: ${count} stale or deleted photo records. Use --apply to clean up.`,
    );
} else {
    const { data, error } = await admin.rpc('slot_photos_cleanup');
    if (error) throw new Error('Cleanup query failed');
    const repo = createPhotoRepository(url, key);
    let removed = 0;
    for (const photo of data || []) {
        try {
            await repo.remove(photo);
            removed++;
        } catch { /* retry next run */ }
    }
    console.info(`Removed ${removed} of ${(data || []).length} queued photos`);
}
