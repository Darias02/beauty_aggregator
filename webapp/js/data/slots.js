import { supabase } from './supabase.js';


export async function getAvailableSlots(
    serviceId,
    city = null
) {
    if (!serviceId) {
        return [];
    }

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
        query = query.eq(
            'city',
            city
        );
    }


    const { data, error } =
        await query;


    if (error) {
        throw error;
    }

    return data || [];
}


export async function getSlot(
    slotId
) {
    if (!slotId) {
        return null;
    }

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

    if (error) {
        throw error;
    }

    return data;
}


export async function getMasterSlots(
    masterId
) {
    if (!masterId) {
        return [];
    }

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

    if (error) {
        throw error;
    }

    return data || [];
}


export async function getMasterActiveSlots(
    masterId
) {
    if (!masterId) {
        return [];
    }

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
        .in(
            'status',
            [
                'Свободен',
                'Ожидает подтверждения',
                'Занят'
            ]
        )
        .order('date_time');

    if (error) {
        throw error;
    }

    return data || [];
}


export async function createSlot({
    masterId,
    serviceId,
    dateTime,
    city = '',
    address = '',
    description = ''
}) {
    if (!masterId) {
        throw new Error('Master ID is required.');
    }

    if (!serviceId) {
        throw new Error('Service ID is required.');
    }

    if (!dateTime) {
        throw new Error('Date and time are required.');
    }


    const { data: existingSlot, error: existingError } =
        await supabase
            .from('slots')
            .select('slot_id')
            .eq('master_id', masterId)
            .eq('date_time', dateTime)
            .limit(1)
            .maybeSingle();


    if (existingError) {
        throw existingError;
    }


    if (existingSlot) {
        throw new Error(
            'Слот на это время уже существует.'
        );
    }


    const { data, error } =
        await supabase
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
        throw error;
    }

    return data;
}


export async function updateSlotStatus(
    slotId,
    status
) {
    if (!slotId) {
        throw new Error('Slot ID is required.');
    }

    const { data, error } =
        await supabase
            .from('slots')
            .update({
                status
            })
            .eq('slot_id', slotId)
            .select()
            .single();

    if (error) {
        throw error;
    }

    return data;
}


export async function cancelSlot(
    slotId
) {
    return updateSlotStatus(
        slotId,
        'Отменен'
    );
}