import { supabase } from './supabase.js';


export async function createBooking(
    userId,
    slotId
) {
    if (!userId) {
        throw new Error('User ID is required.');
    }

    if (!slotId) {
        throw new Error('Slot ID is required.');
    }


    const {
        data: slot,
        error: slotError
    } = await supabase
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


    if (slotError) {
        throw slotError;
    }


    if (!slot) {
        throw new Error(
            'Слот не найден.'
        );
    }


    if (slot.status !== 'Свободен') {
        throw new Error(
            'Этот слот уже недоступен.'
        );
    }


    const {
        data: booking,
        error: bookingError
    } = await supabase
        .from('bookings')
        .insert({
            user_id: userId,
            slot_id: slotId,
            status:
                'Ожидает подтверждения мастера'
        })
        .select()
        .single();


    if (bookingError) {
        throw bookingError;
    }


    const {
        error: updateSlotError
    } = await supabase
        .from('slots')
        .update({
            status:
                'Ожидает подтверждения'
        })
        .eq('slot_id', slotId);


    if (updateSlotError) {
        throw updateSlotError;
    }


    return {
        ...booking,
        slot
    };
}


export async function getUserBookings(
    userId
) {
    if (!userId) {
        return [];
    }

    const {
        data,
        error
    } = await supabase
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
        .order(
            'booking_id',
            {
                ascending: false
            }
        );


    if (error) {
        throw error;
    }

    return data || [];
}


export async function getMasterBookings(
    masterId
) {
    if (!masterId) {
        return [];
    }


    const {
        data: slots,
        error: slotsError
    } = await supabase
        .from('slots')
        .select('slot_id')
        .eq('master_id', masterId);


    if (slotsError) {
        throw slotsError;
    }


    const slotIds =
        (slots || []).map(
            (slot) => slot.slot_id
        );


    if (!slotIds.length) {
        return [];
    }


    const {
        data,
        error
    } = await supabase
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
        .in(
            'slot_id',
            slotIds
        )
        .order(
            'booking_id',
            {
                ascending: false
            }
        );


    if (error) {
        throw error;
    }

    return data || [];
}


export async function getBooking(
    bookingId
) {
    if (!bookingId) {
        return null;
    }

    const {
        data,
        error
    } = await supabase
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
        .eq(
            'booking_id',
            bookingId
        )
        .limit(1)
        .maybeSingle();


    if (error) {
        throw error;
    }

    return data;
}


export async function confirmBooking(
    bookingId
) {
    const booking =
        await getBooking(
            bookingId
        );


    if (!booking) {
        throw new Error(
            'Заявка не найдена.'
        );
    }


    const {
        data,
        error
    } = await supabase
        .from('bookings')
        .update({
            status: 'Активна'
        })
        .eq(
            'booking_id',
            bookingId
        )
        .select()
        .single();


    if (error) {
        throw error;
    }


    await updateSlotForBooking(
        booking.slot_id,
        'Занят'
    );


    return data;
}


export async function rejectBooking(
    bookingId,
    reason = 'model'
) {
    const booking =
        await getBooking(
            bookingId
        );


    if (!booking) {
        throw new Error(
            'Заявка не найдена.'
        );
    }


    const {
        data,
        error
    } = await supabase
        .from('bookings')
        .update({
            status:
                'Отменена мастером'
        })
        .eq(
            'booking_id',
            bookingId
        )
        .select()
        .single();


    if (error) {
        throw error;
    }


    const newSlotStatus =
        reason === 'plans'
            ? 'Отменен'
            : 'Свободен';


    await updateSlotForBooking(
        booking.slot_id,
        newSlotStatus
    );


    return data;
}


export async function cancelBooking(
    bookingId
) {
    const booking =
        await getBooking(
            bookingId
        );


    if (!booking) {
        throw new Error(
            'Запись не найдена.'
        );
    }


    const {
        data,
        error
    } = await supabase
        .from('bookings')
        .update({
            status: 'Отменена моделью'
        })
        .eq(
            'booking_id',
            bookingId
        )
        .select()
        .single();


    if (error) {
        throw error;
    }


    await updateSlotForBooking(
        booking.slot_id,
        'Свободен'
    );


    return data;
}


async function updateSlotForBooking(
    slotId,
    status
) {
    const {
        error
    } = await supabase
        .from('slots')
        .update({
            status
        })
        .eq(
            'slot_id',
            slotId
        );


    if (error) {
        throw error;
    }
}