import { supabase } from './supabase.js';
import { sendNotification } from './notifications.js';

async function getSlot(slotId) {
    const { data, error } = await supabase
        .from('slots')
        .select(`
            *,
            services (
                service_id,
                name,
                icon_url
            )
        `)
        .eq('slot_id', slotId)
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

export async function getBooking(bookingId) {
    const { data, error } = await supabase
        .from('bookings')
        .select(`
            *,
            slots (
                *,
                services (
                    service_id,
                    name,
                    icon_url
                )
            )
        `)
        .eq('booking_id', bookingId)
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

export async function createBooking(userId, slotId) {
    const slot = await getSlot(slotId);

    if (!slot) throw new Error('Слот не найден.');
    if (slot.status !== 'Свободен') throw new Error('Этот слот уже недоступен.');

    const { data: booking, error } = await supabase
        .from('bookings')
        .insert({
            user_id: userId,
            slot_id: slotId,
            status: 'Ожидает подтверждения мастера',
            reason: null
        })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') {
            throw new Error('Этот слот уже забронировали.');
        }
        throw error;
    }

    const { error: slotError } = await supabase
        .from('slots')
        .update({ status: 'Ожидает подтверждения' })
        .eq('slot_id', slotId)
        .eq('status', 'Свободен');

    if (slotError) throw slotError;

    await sendNotification('notify-master', {
        type: 'booking_created',
        booking_id: booking.booking_id
    });

    return { ...booking, slot };
}

export async function getUserBookings(userId) {
    const { data, error } = await supabase
        .from('bookings')
        .select(`
            *,
            slots (
                slot_id,
                master_id,
                service_id,
                date_time,
                status,
                city,
                address,
                description,
                services (
                    service_id,
                    name,
                    icon_url
                )
            )
        `)
        .eq('user_id', userId)
        .order('booking_id', { ascending: false });

    if (error) throw error;
    return data || [];
}

export async function getMasterBookings(masterId) {
    const { data: slots, error: slotsError } = await supabase
        .from('slots')
        .select('slot_id')
        .eq('master_id', masterId);

    if (slotsError) throw slotsError;

    const slotIds = (slots || []).map((slot) => slot.slot_id);
    if (!slotIds.length) return [];

    const { data, error } = await supabase
        .from('bookings')
        .select(`
            *,
            slots (
                slot_id,
                master_id,
                service_id,
                date_time,
                status,
                city,
                address,
                description,
                services (
                    service_id,
                    name,
                    icon_url
                )
            )
        `)
        .in('slot_id', slotIds)
        .order('booking_id', { ascending: false });

    if (error) throw error;
    return data || [];
}

export async function confirmBooking(bookingId) {
    const booking = await getBooking(bookingId);
    if (!booking) throw new Error('Заявка не найдена.');

    const { data, error } = await supabase
        .from('bookings')
        .update({
            status: 'Активна',
            reason: null
        })
        .eq('booking_id', bookingId)
        .eq('status', 'Ожидает подтверждения мастера')
        .select()
        .single();

    if (error) throw error;

    const { error: slotError } = await supabase
        .from('slots')
        .update({ status: 'Занят' })
        .eq('slot_id', booking.slot_id);

    if (slotError) throw slotError;

    await sendNotification('notify-user', {
        type: 'booking_confirmed',
        booking_id: bookingId
    });

    return data;
}

export async function rejectBooking(bookingId, reason) {
    if (!['model', 'plans'].includes(reason)) {
        throw new Error('Укажите причину отклонения.');
    }

    const booking = await getBooking(bookingId);
    if (!booking) throw new Error('Заявка не найдена.');

    const { data, error } = await supabase
        .from('bookings')
        .update({
            status: 'Отменена мастером',
            reason
        })
        .eq('booking_id', bookingId)
        .eq('status', 'Ожидает подтверждения мастера')
        .select()
        .single();

    if (error) throw error;

    const newSlotStatus = reason === 'plans' ? 'Отменен' : 'Свободен';

    const { error: slotError } = await supabase
        .from('slots')
        .update({ status: newSlotStatus })
        .eq('slot_id', booking.slot_id);

    if (slotError) throw slotError;

    await sendNotification('notify-user', {
        type: 'booking_rejected',
        booking_id: bookingId,
        reason
    });

    return data;
}

export async function cancelBooking(bookingId, reason) {
    if (!['time', 'other'].includes(reason)) {
        throw new Error('Укажите причину отмены.');
    }

    const booking = await getBooking(bookingId);
    if (!booking) throw new Error('Запись не найдена.');

    const { data, error } = await supabase
        .from('bookings')
        .update({
            status: 'Отменена моделью',
            reason
        })
        .eq('booking_id', bookingId)
        .in('status', [
            'Ожидает подтверждения мастера',
            'Активна'
        ])
        .select()
        .single();

    if (error) throw error;

    const { error: slotError } = await supabase
        .from('slots')
        .update({ status: 'Свободен' })
        .eq('slot_id', booking.slot_id);

    if (slotError) throw slotError;

    await sendNotification('notify-master', {
        type: 'model_cancelled',
        booking_id: bookingId
    });

    return data;
}