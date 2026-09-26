import { supabase } from './supabase.js';


export async function getUser(userId) {
    if (!userId) {
        return null;
    }

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data;
}


export async function createOrUpdateUser({
    userId,
    name,
    phoneNumber = null
}) {
    if (!userId) {
        throw new Error('User ID is required.');
    }

    const payload = {
        user_id: userId,
        name: name || 'Никнейм'
    };

    if (phoneNumber) {
        payload.phone_number = phoneNumber;
    }

    const { data, error } = await supabase
        .from('users')
        .upsert(
            payload,
            {
                onConflict: 'user_id'
            }
        )
        .select()
        .single();

    if (error) {
        throw error;
    }

    return data;
}


export async function updateUserName(
    userId,
    name
) {
    if (!userId) {
        throw new Error('User ID is required.');
    }

    const cleanName = String(name || '').trim();

    if (!cleanName) {
        throw new Error('Name cannot be empty.');
    }

    const { data, error } = await supabase
        .from('users')
        .update({
            name: cleanName
        })
        .eq('user_id', userId)
        .select()
        .single();

    if (error) {
        throw error;
    }

    return data;
}