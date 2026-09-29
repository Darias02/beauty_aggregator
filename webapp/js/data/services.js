import { supabase } from './supabase.js';

export async function getServices() {
    const { data, error } = await supabase
        .from('services')
        .select('*')
        .order('service_id')
        .limit(100);

    if (error) throw error;
    return data || [];
}

export async function getAvailableServiceCounts() {
    const { data, error } = await supabase
        .from('slots')
        .select('service_id')
        .eq('status', 'Свободен');

    if (error) throw error;

    const counts = {};

    for (const slot of data || []) {
        counts[slot.service_id] = (counts[slot.service_id] || 0) + 1;
    }

    return counts;
}

export async function getAvailableCities() {
    const { data, error } = await supabase
        .from('slots')
        .select('city')
        .not('city', 'is', null);

    if (error) throw error;

    return [...new Set(
        (data || [])
            .map((row) => String(row.city || '').trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'ru'));
}