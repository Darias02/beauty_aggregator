import { supabase } from './supabase.js';

export async function getUser(userId) {
    if (!userId) return null;

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

export async function createOrUpdateUser({ userId, name, phoneNumber = null }) {
    if (!userId) throw new Error('User ID is required.');

    const existing = await getUser(userId);
    if (existing) return existing;

    const payload = {
        user_id: userId,
        name: String(name || 'Никнейм').trim()
    };

    if (phoneNumber) payload.phone_number = phoneNumber;

    const { data, error } = await supabase
        .from('users')
        .insert(payload)
        .select()
        .single();

    if (error) throw error;
    return data;
}

export async function updateUserName(userId, name) {
    const cleanName = String(name || '').trim();

    if (!userId || !cleanName) {
        throw new Error('Введите корректный никнейм.');
    }

    const { data, error } = await supabase
        .from('users')
        .update({ name: cleanName })
        .eq('user_id', userId)
        .select()
        .single();

    if (error) throw error;
    return data;
}