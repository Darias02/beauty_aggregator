import { supabase } from './supabase.js';

export async function getAvailableSlots(serviceId, city = null, userId = null) {
    if (!serviceId) return [];

    let query = supabase
        .from('slots')
        .select(`
            *,
            services (
                service_id,
                name,
                icon_url
            )
        `)
        .eq('service_id', serviceId)
        .eq('status', 'Свободен')
        .order('date_time');

    if (city && city !== 'Город') {
        query = query.eq('city', city);
    }

    const { data, error } = await query;

    if (error) throw error;

    let slots = data || [];

    if (userId && slots.length) {
        const { data: rejected, error: rejectedError } = await supabase
            .from('bookings')
            .select('slot_id')
            .eq('user_id', userId)
            .eq('status', 'Отменена мастером')
            .eq('reason', 'model');

        if (rejectedError) throw rejectedError;

        const hiddenSlotIds = new Set(
            (rejected || []).map((row) => row.slot_id)
        );

        slots = slots.filter((slot) => !hiddenSlotIds.has(slot.slot_id));
    }

    return slots.filter((slot) => new Date(slot.date_time) > new Date());
}

export async function getSlot(slotId) {
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

export async function getMasterSlots(masterId) {
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
        .eq('master_id', masterId)
        .order('date_time');

    if (error) throw error;
    return data || [];
}

export async function createSlot({ masterId, serviceId, dateTime, city, address = '', description = '' }) {
    if (!masterId || !serviceId || !dateTime || !city) {
        throw new Error('Заполните услугу, город, дату и время.');
    }

    const { data, error } = await supabase
        .from('slots')
        .insert({
            master_id: masterId,
            service_id: serviceId,
            date_time: dateTime,
            status: 'Свободен',
            city,
            address,
            description
        })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') {
            throw new Error('Слот на это время уже существует.');
        }
        throw error;
    }

    return data;
}

export async function deleteSlot(slotId, masterId) {
    const { error } = await supabase
        .from('slots')
        .delete()
        .eq('slot_id', slotId)
        .eq('master_id', masterId)
        .eq('status', 'Свободен');

    if (error) throw error;
}

export async function cancelSlot(slotId, masterId) {
    const slot = await getSlot(slotId);

    if (!slot || slot.master_id !== masterId) {
        throw new Error('Слот не найден.');
    }

    const { data: booking, error } = await supabase
        .from('bookings')
        .select('booking_id,status')
        .eq('slot_id', slotId)
        .in('status', [
            'Ожидает подтверждения мастера',
            'Активна'
        ])
        .limit(1)
        .maybeSingle();

    if (error) throw error;

    if (!booking) {
        await deleteSlot(slotId, masterId);
        return { deleted: true };
    }

    const { data, error: bookingError } = await supabase
        .from('bookings')
        .update({
            status: 'Отменена мастером',
            reason: 'plans'
        })
        .eq('booking_id', booking.booking_id)
        .select()
        .single();

    if (bookingError) throw bookingError;

    const { error: slotError } = await supabase
        .from('slots')
        .update({ status: 'Отменен' })
        .eq('slot_id', slotId)
        .eq('master_id', masterId);

    if (slotError) throw slotError;

    return { deleted: false, booking: data };
}