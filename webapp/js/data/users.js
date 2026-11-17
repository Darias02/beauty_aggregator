import { APP_CONFIG } from '../config.js';
import { getTelegramInitData } from '../telegram.js';

const messages = {
    UNAUTHORIZED: 'Авторизация отсутствует или истекла. Откройте приложение заново через Telegram.',
    INVALID_NAME: 'Введите никнейм длиной от 1 до 100 символов без управляющих символов.',
    PROFILE_NOT_FOUND: 'Профиль не найден. Откройте профиль повторно.',
    SERVER_NOT_CONFIGURED: 'Сервис профиля пока недоступен. Попробуйте позже.',
    PROFILE_UNAVAILABLE: 'Не удалось загрузить или сохранить профиль. Попробуйте позже.',
};

export class ProfileApiError extends Error {
    constructor(code, status = 0) {
        super(messages[code] || messages.PROFILE_UNAVAILABLE);
        this.name = 'ProfileApiError';
        this.code = code;
        this.status = status;
    }
}

export function createProfileClient({ url, key, getInitData, fetchImpl = globalThis.fetch }) {
    async function request(action, patch) {
        const initData = getInitData();
        if (typeof initData !== 'string' || !initData) {
            throw new ProfileApiError('UNAUTHORIZED', 401);
        }
        const body = { action, init_data: initData };
        if (patch !== undefined) body.profile = patch;

        let response;
        let result;
        try {
            response = await fetchImpl(`${url}/functions/v1/user-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key },
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                body: JSON.stringify(body),
            });
            result = await response.json();
        } catch {
            throw new ProfileApiError('PROFILE_UNAVAILABLE');
        }
        if (!response.ok) {
            const code = response.status === 401 ? 'UNAUTHORIZED' : result?.error?.code;
            throw new ProfileApiError(
                Object.hasOwn(messages, code) ? code : 'PROFILE_UNAVAILABLE',
                response.status,
            );
        }
        const profile = result?.profile;
        if (
            !Number.isSafeInteger(profile?.user_id) || profile.user_id <= 0 ||
            typeof profile.name !== 'string'
        ) {
            throw new ProfileApiError('PROFILE_UNAVAILABLE', response.status);
        }
        return { user_id: profile.user_id, name: profile.name };
    }

    return {
        getOwnProfile: () => request('get'),
        ensureOwnProfile: () => request('ensure'),
        updateOwnProfileName: (name) => request('update', { name }),
    };
}

const client = createProfileClient({
    url: APP_CONFIG.supabase.url,
    key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData,
    fetchImpl: (...args) => fetch(...args),
});

export const { getOwnProfile, ensureOwnProfile, updateOwnProfileName } = client;
