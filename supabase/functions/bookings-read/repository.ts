import { createClient } from '@supabase/supabase-js';
import type { Slot } from '../slots-read/repository.ts';

export interface Booking {
    booking_id: number;
    user_id: number | null;
    slot_id: number | null;
    status: string | null;
    reason: string | null;
    slots: Slot | null;
}

export interface BookingsRepository {
    getBooking(actorId: number, bookingId: number): Promise<Booking | null>;
    getPage(actorId: number, role: 'user' | 'master', before: number | null): Promise<Booking[]>;
}

const slotColumns = 'slot_id,date_time,status,master_id,service_id,city,address,description,services(service_id,name)';
const columns = (master: boolean) =>
    `booking_id,user_id,slot_id,status,reason,slots${master ? '!inner' : ''}(${slotColumns})`;
export const PAGE_SIZE = 500;

export function createSupabaseBookingsRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
): BookingsRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });

    return {
        async getBooking(actorId, bookingId) {
            // Never fetch an unscoped booking, even with the privileged server client.
            const own = await admin.from('bookings').select(columns(false))
                .eq('booking_id', bookingId).eq('user_id', actorId).maybeSingle()
                .overrideTypes<Booking | null, { merge: false }>();
            if (own.error) throw own.error;
            if (own.data) return own.data;
            const master = await admin.from('bookings').select(columns(true))
                .eq('booking_id', bookingId).eq('slots.master_id', actorId).maybeSingle()
                .overrideTypes<Booking | null, { merge: false }>();
            if (master.error) throw master.error;
            return master.data;
        },
        async getPage(actorId, role, before) {
            const master = role === 'master';
            let query = admin.from('bookings').select(columns(master));
            query = master ? query.eq('slots.master_id', actorId) : query.eq('user_id', actorId);
            if (before !== null) query = query.lt('booking_id', before);
            const { data, error } = await query.order('booking_id', { ascending: false })
                .limit(PAGE_SIZE).overrideTypes<Booking[], { merge: false }>();
            if (error) throw error;
            if (!data) throw new Error('Missing bookings page');
            return data;
        },
    };
}
