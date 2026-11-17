import { createClient } from '@supabase/supabase-js';

export type DecisionAction = 'confirm' | 'reject' | 'cancel';
export type DecisionReason = 'model' | 'plans' | 'time' | 'other' | null;
export interface DecisionResult {
    booking: { booking_id: number; slot_id: number; user_id: number; status: string; reason: DecisionReason };
    replayed: boolean;
}
export interface BookingsWriteRepository {
    decide(actorId: number, bookingId: number, action: DecisionAction, reason: DecisionReason): Promise<DecisionResult>;
}

export function validDecision(value: unknown, id: number, action: DecisionAction, reason: DecisionReason): value is DecisionResult {
    if (!value || typeof value !== 'object' || !('booking' in value) ||
        !('replayed' in value) || typeof value.replayed !== 'boolean') return false;
    const b = value.booking;
    return !!b && typeof b === 'object' &&
        'booking_id' in b && b.booking_id === id &&
        'slot_id' in b && Number.isSafeInteger(b.slot_id) && Number(b.slot_id) > 0 &&
        'user_id' in b && Number.isSafeInteger(b.user_id) && Number(b.user_id) > 0 &&
        'status' in b && b.status === (action === 'confirm' ? 'Активна' : action === 'cancel' ? 'Отменена моделью' : 'Отменена мастером') &&
        'reason' in b && b.reason === reason;
}

export function createSupabaseBookingsWriteRepository(url: string, key: string, fetchImpl: typeof fetch = fetch): BookingsWriteRepository {
    const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fetchImpl },
    });
    return {
        async decide(actorId, bookingId, action, reason) {
            const { data, error } = await admin.rpc(action === 'cancel' ? 'bb67_cancel_booking' : 'bb66_decide_booking',
                action === 'cancel'
                    ? { p_user_id: actorId, p_booking_id: bookingId, p_reason: reason }
                    : { p_master_id: actorId, p_booking_id: bookingId, p_action: action, p_reason: reason });
            if (error) throw error;
            if (!validDecision(data, bookingId, action, reason)) throw new Error('Invalid RPC result');
            return data;
        },
    };
}
