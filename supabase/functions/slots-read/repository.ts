import { createClient } from '@supabase/supabase-js';

export interface Slot {
    slot_id: number;
    date_time: string;
    status: string | null;
    master_id: number | null;
    service_id: number | null;
    city: string | null;
    address: string | null;
    description: string | null;
    services: { service_id: number; name: string } | null;
}

export interface SlotsRepository {
    getAvailableSlots(
        actorId: number,
        serviceId: number,
        city: string | null,
        now: string,
    ): Promise<Slot[]>;
    getSlot(actorId: number, slotId: number, now: string): Promise<Slot | null>;
    getMasterSlots(actorId: number): Promise<Slot[]>;
}

// The schema snapshot defines slots.service_id as a many-to-one FK to services.
const columns =
    'slot_id,date_time,status,master_id,service_id,city,address,description,services(service_id,name)';
const PAGE_SIZE = 500;

// Stop only on an empty page: PostgREST can cap responses below PAGE_SIZE.
async function collect<T>(
    page: (offset: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
    const rows: T[] = [];
    while (true) {
        const { data, error } = await page(rows.length);
        if (error) throw error;
        if (!data?.length) return rows;
        rows.push(...data);
    }
}

export function createSupabaseSlotsRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
): SlotsRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });

    async function hiddenSlots(actorId: number): Promise<Set<number>> {
        const rejected = await collect<{ slot_id: number | null }>((offset) =>
            admin.from('bookings').select('slot_id').eq('user_id', actorId)
                .eq('status', 'Отменена мастером').eq('reason', 'model')
                .order('booking_id').range(offset, offset + PAGE_SIZE - 1)
        );
        return new Set(rejected.flatMap((row) => row.slot_id === null ? [] : [row.slot_id]));
    }

    return {
        async getAvailableSlots(actorId, serviceId, city, now) {
            const hidden = await hiddenSlots(actorId);
            const slots = await collect<Slot>((offset) => {
                let query = admin.from('slots').select(columns)
                    .eq('service_id', serviceId).eq('status', 'Свободен').gt('date_time', now);
                if (city) query = query.eq('city', city);
                return query.order('date_time').order('slot_id').range(
                    offset,
                    offset + PAGE_SIZE - 1,
                )
                    .overrideTypes<Slot[], { merge: false }>();
            });
            return slots.filter((slot) => !hidden.has(slot.slot_id));
        },
        async getSlot(actorId, slotId, now) {
            const { data: slot, error } = await admin.from('slots').select(columns)
                .eq('slot_id', slotId).maybeSingle().overrideTypes<Slot | null, { merge: false }>();
            if (error) throw error;
            if (!slot) return null;
            if (slot.master_id === actorId) return slot;
            if (slot.status !== 'Свободен' || !(Date.parse(slot.date_time) > Date.parse(now))) {
                return null;
            }
            // Check only this actor's rejection, without exposing bookings in the response.
            const { data: rejected, error: rejectionError } = await admin.from('bookings')
                .select('slot_id').eq('slot_id', slotId).eq('user_id', actorId)
                .eq('status', 'Отменена мастером').eq('reason', 'model').limit(1);
            if (rejectionError) throw rejectionError;
            return rejected?.length ? null : slot;
        },
        getMasterSlots(actorId) {
            return collect<Slot>((offset) =>
                admin.from('slots').select(columns)
                    .eq('master_id', actorId).order('date_time').order('slot_id')
                    .range(offset, offset + PAGE_SIZE - 1).overrideTypes<Slot[], { merge: false }>()
            );
        },
    };
}
