import { supabase } from './supabase.js';
import { getTelegramDisplayName, setMasterAvatarUrl } from '../telegram.js';

export async function getMaster(masterId) {
    if (!masterId) return null;

    const { data, error } = await supabase
        .from('masters')
        .select('*')
        .eq('master_id', masterId)
        .limit(1)
        .maybeSingle();

    if (error) throw error;

    if (data) setMasterAvatarUrl(data.avatar_url || null);
    return data;
}

export async function ensureMaster(masterId) {
    const existing = await getMaster(masterId);
    if (existing) return existing;

    const { data, error } = await supabase
        .from('masters')
        .insert({
            master_id: masterId,
            name: getTelegramDisplayName()
        })
        .select()
        .single();

    if (error) throw error;

    setMasterAvatarUrl(data?.avatar_url || null);
    return data;
}

export async function updateMasterName(masterId, name) {
    const cleanName = String(name || '').trim();

    if (!masterId || !cleanName) {
        throw new Error('Введите корректный никнейм.');
    }

    const { data, error } = await supabase
        .from('masters')
        .update({ name: cleanName })
        .eq('master_id', masterId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

export async function updateMasterAddress(masterId, address) {
    const { data, error } = await supabase
        .from('masters')
        .update({ address: String(address || '').trim() })
        .eq('master_id', masterId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

export async function uploadMasterAvatar(masterId, file) {
    if (!masterId || !file) throw new Error('Не выбрана фотография.');
    if (!file.type.startsWith('image/')) throw new Error('Выберите изображение.');

    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${masterId}/avatar.${extension}`;

    const { error: uploadError } = await supabase.storage
        .from('master-avatars')
        .upload(path, file, {
            upsert: true,
            contentType: file.type,
            cacheControl: '3600'
        });

    if (uploadError) throw uploadError;

    const { data } = supabase.storage
        .from('master-avatars')
        .getPublicUrl(path);

    const avatarUrl = data.publicUrl;

    const { data: master, error } = await supabase
        .from('masters')
        .update({ avatar_url: avatarUrl })
        .eq('master_id', masterId)
        .select()
        .single();

    if (error) throw error;

    setMasterAvatarUrl(avatarUrl);
    return master;
}