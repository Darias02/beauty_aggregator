import { APP_CONFIG } from '../config.js';
import { getTelegramInitData, setMasterAvatarUrl } from '../telegram.js';

const messages = {
    INVALID_IMAGE: 'Выберите изображение.',
    AVATAR_TOO_LARGE: 'Размер фотографии не должен превышать 5 МиБ.',
    AVATAR_UNAVAILABLE: 'Не удалось сохранить фото.',
    UNAUTHORIZED: 'Авторизация отсутствует или истекла. Откройте приложение заново через Telegram.',
    INVALID_ADDRESS: 'Введите адрес длиной до 500 символов без управляющих символов.',
    INVALID_NAME: 'Введите никнейм длиной от 1 до 100 символов без управляющих символов.',
    PROFILE_NOT_FOUND: 'Профиль не найден. Откройте профиль повторно.',
    SERVER_NOT_CONFIGURED: 'Сервис профиля пока недоступен. Попробуйте позже.',
    PROFILE_UNAVAILABLE: 'Не удалось загрузить или сохранить профиль. Попробуйте позже.',
};

export class MasterProfileApiError extends Error {
    constructor(code, status = 0) {
        super(messages[code] || messages.PROFILE_UNAVAILABLE);
        this.name = 'MasterProfileApiError';
        this.code = code;
        this.status = status;
    }
}

export function createMasterProfileClient({ url, key, getInitData, fetchImpl = globalThis.fetch }) {
    async function request(action, patch, file) {
        const initData = getInitData();
        if (typeof initData !== 'string' || !initData) {
            throw new MasterProfileApiError('UNAUTHORIZED', 401);
        }
        const body = { action, init_data: initData };
        if (patch !== undefined) body.profile = patch;

        let payload = JSON.stringify(body);
        const headers = { apikey: key };
        if (file !== undefined) {
            payload = new FormData();
            payload.append('init_data', initData);
            payload.append('avatar', file);
        } else {
            headers['Content-Type'] = 'application/json';
        }

        const unavailable = file !== undefined ? 'AVATAR_UNAVAILABLE' : 'PROFILE_UNAVAILABLE';
        let response;
        let result;
        const endpoint = file !== undefined ? 'master-avatar' : 'master-profile';
        try {
            response = await fetchImpl(`${url}/functions/v1/${endpoint}`, {
                method: 'POST',
                headers,
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                body: payload,
            });
            result = await response.json();
        } catch {
            throw new MasterProfileApiError(unavailable);
        }
        if (!response.ok) {
            const code = response.status === 401 ? 'UNAUTHORIZED' : result?.error?.code;
            throw new MasterProfileApiError(
                Object.hasOwn(messages, code) ? code : unavailable,
                response.status,
            );
        }
        const profile = result?.profile;
        if (
            !Number.isSafeInteger(profile?.master_id) || profile.master_id <= 0 ||
            typeof profile.name !== 'string' ||
            !(profile.address === null || typeof profile.address === 'string') ||
            !(profile.avatar_url === null || typeof profile.avatar_url === 'string')
        ) {
            throw new MasterProfileApiError(unavailable, response.status);
        }
        return {
            master_id: profile.master_id,
            name: profile.name,
            address: profile.address,
            avatar_url: profile.avatar_url,
        };
    }

    return {
        uploadOwnAvatar: (file) => request(undefined, undefined, file),
        getOwnProfile: () => request('get'),
        ensureOwnProfile: () => request('ensure'),
        updateOwnProfileName: (name) => request('update', { name }),
        updateOwnProfileAddress: (address) => request('update', { address }),
    };
}

const client = createMasterProfileClient({
    url: APP_CONFIG.supabase.url,
    key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData,
    fetchImpl: (...args) => fetch(...args),
});

export const { getOwnProfile, ensureOwnProfile, updateOwnProfileName, updateOwnProfileAddress } = client;

// Compatibility for existing master entry points. Identity is never sent to the API.
export async function getMaster(_masterId) {
    const master = await client.getOwnProfile();
    setMasterAvatarUrl(master.avatar_url || null);
    return master;
}

export async function ensureMaster(_masterId) {
    const master = await client.ensureOwnProfile();
    setMasterAvatarUrl(master.avatar_url || null);
    return master;
}

export async function updateMasterName(masterId, name) {
    const cleanName = String(name || '').trim();
    if (!masterId || !cleanName) throw new Error('Введите корректный никнейм.');
    return await client.updateOwnProfileName(cleanName);
}

export async function updateMasterAddress(_masterId, address) {
    return await client.updateOwnProfileAddress(String(address || '').trim());
}

export async function uploadMasterAvatar(_masterId, file) {
    if (!file) throw new Error('Не выбрана фотография.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new MasterProfileApiError('INVALID_IMAGE');
    }
    if (file.size > 5 * 1024 * 1024) throw new MasterProfileApiError('AVATAR_TOO_LARGE');
    const master = await client.uploadOwnAvatar(file);
    setMasterAvatarUrl(master.avatar_url);
    return master;
}
