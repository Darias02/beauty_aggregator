const supabaseUrl = 'https://bxzwfidujuejmrbqjmgo.supabase.co';
const supabaseKey = 'sb_publishable_eQsfW9mYbM1i3Vhwr7h8ig_jM29E24C';

const supabaseClient = window.supabase.createClient(
    supabaseUrl,
    supabaseKey
);

window.supabaseClient = supabaseClient;

export async function getServices() {
    const { data, error } = await supabaseClient
        .from('services')
        .select('*')
        .limit(7);

    if (error) {
        throw error;
    }

    return data ?? [];
}

export async function getAvailableSlots(serviceId, city = null) {
    let query = supabaseClient
        .from('slots')
        .select('*, services(icon_url)')
        .eq('service_id', serviceId)
        .eq('status', 'Свободен');

    if (city && city !== 'Город') {
        query = query.eq('city', city);
    }

    const { data, error } = await query;

    if (error) {
        throw error;
    }

    return data ?? [];
}

export async function getAvailableSlotCounts() {
    const { data, error } = await supabaseClient
        .from('slots')
        .select('service_id')
        .eq('status', 'Свободен');

    if (error) {
        throw error;
    }

    const counts = {};

    for (const slot of data ?? []) {
        counts[slot.service_id] =
            (counts[slot.service_id] || 0) + 1;
    }

    return counts;
}

export async function createBooking(userId, slotId) {
    const { data, error } = await supabaseClient
        .from('bookings')
        .insert({
            user_id: userId,
            slot_id: slotId,
            status: 'Ожидает подтверждения мастера'
        })
        .select()
        .single();

    if (error) {
        throw error;
    }

    const { error: slotError } = await supabaseClient
        .from('slots')
        .update({
            status: 'Ожидает подтверждения'
        })
        .eq('slot_id', slotId);

    if (slotError) {
        throw slotError;
    }

    return data;
}