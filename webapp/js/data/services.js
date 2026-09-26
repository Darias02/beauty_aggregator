import { supabase } from './supabase.js';


export async function getServices() {
    const { data, error } = await supabase
        .from('services')
        .select('*')
        .order('service_id')
        .limit(7);

    if (error) {
        throw error;
    }

    return data || [];
}


export async function getServiceById(
    serviceId
) {
    if (!serviceId) {
        return null;
    }

    const { data, error } = await supabase
        .from('services')
        .select('*')
        .eq('service_id', serviceId)
        .limit(1)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data;
}


export async function getServiceByName(
    name
) {
    if (!name) {
        return null;
    }

    const { data, error } = await supabase
        .from('services')
        .select('*')
        .eq('name', name)
        .limit(1)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data;
}


export async function getAvailableServiceCounts() {
    const { data, error } = await supabase
        .from('slots')
        .select('service_id')
        .eq('status', 'Свободен');

    if (error) {
        throw error;
    }

    const counts = {};

    for (const slot of data || []) {
        const serviceId = slot.service_id;

        counts[serviceId] =
            (counts[serviceId] || 0) + 1;
    }

    return counts;
}