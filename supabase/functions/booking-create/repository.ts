import { createClient } from '@supabase/supabase-js';
import type { BookingRepository } from './handler.ts';

export function createSupabaseBookingRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
): BookingRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });
    return {
        async book(userId, slotId) {
            const { data, error } = await admin.rpc('bb24_book_slot', {
                p_user_id: userId,
                p_slot_id: slotId,
            });
            if (error) throw error;
            return data;
        },
    };
}
