import { createClient } from '@supabase/supabase-js';

export interface SlotInput {
    service_id: number;
    date_time: string;
    city: string;
    address: string;
    description: string;
}

export interface CreatedSlot extends SlotInput {
    slot_id: number;
    master_id: number;
    status: string;
}

export interface SlotsWriteRepository {
    create(masterId: number, input: SlotInput): Promise<CreatedSlot>;
    delete(masterId: number, slotId: number): Promise<void>;
    cancel(masterId: number, slotId: number): Promise<CancelledSlot>;
}

export type CancelledSlot = { deleted: true } | {
    deleted: false;
    booking: { booking_id: number; slot_id: number; status: string; reason: string };
};

export function validCancellation(value: unknown, slotId: number): value is CancelledSlot {
    if (!value || typeof value !== 'object' || !('deleted' in value)) return false;
    if (value.deleted === true) return !('booking' in value);
    if (value.deleted !== false || !('booking' in value)) return false;
    const booking = value.booking;
    return !!booking && typeof booking === 'object' &&
        'booking_id' in booking && Number.isSafeInteger(booking.booking_id) &&
        Number(booking.booking_id) > 0 && 'slot_id' in booking && booking.slot_id === slotId &&
        'status' in booking && booking.status === 'Отменена мастером' &&
        'reason' in booking && booking.reason === 'plans';
}

export function createSupabaseSlotsWriteRepository(
    url: string,
    key: string,
    fetchImpl: typeof fetch = fetch,
): SlotsWriteRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });
    return {
        async cancel(masterId, slotId) {
            const { data, error } = await admin.rpc('bb64_cancel_slot', {
                p_master_id: masterId,
                p_slot_id: slotId,
            });
            if (error) throw error;
            if (!validCancellation(data, slotId)) throw new Error('Invalid cancellation result');
            return data;
        },
        async create(masterId, input) {
            const { data, error } = await admin.rpc('bb63_create_slot', {
                p_master_id: masterId,
                p_service_id: input.service_id,
                p_date_time: input.date_time,
                p_city: input.city,
                p_address: input.address,
                p_description: input.description,
            });
            if (error) throw error;
            return data;
        },
        async delete(masterId, slotId) {
            const { data, error } = await admin.rpc('bb63_delete_slot', {
                p_master_id: masterId,
                p_slot_id: slotId,
            });
            if (error) throw error;
            if (data !== true) throw new Error('Invalid deletion result');
        },
    };
}
