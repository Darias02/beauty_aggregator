import { APP_CONFIG } from '../config.js';
import { getTelegramInitData } from '../telegram.js';

const messages = {
    UNAUTHORIZED: 'Авторизация отсутствует или истекла. Откройте приложение заново через Telegram.',
    CATALOG_UNAVAILABLE: 'Не удалось загрузить каталог. Попробуйте позже.',
};

export class CatalogApiError extends Error {
    constructor(code, status = 0) {
        super(messages[code] || messages.CATALOG_UNAVAILABLE);
        this.name = 'CatalogApiError';
        this.code = code;
        this.status = status;
    }
}

export function createCatalogClient({ url, key, getInitData, fetchImpl = globalThis.fetch }) {
    async function request(action) {
        const initData = getInitData();
        if (typeof initData !== 'string' || !initData) {
            throw new CatalogApiError('UNAUTHORIZED', 401);
        }
        let response;
        let result;
        try {
            response = await fetchImpl(`${url}/functions/v1/catalog`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key },
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                body: JSON.stringify({ action, init_data: initData }),
            });
            result = await response.json();
        } catch {
            throw new CatalogApiError('CATALOG_UNAVAILABLE');
        }
        if (!response.ok) {
            throw new CatalogApiError(
                response.status === 401 ? 'UNAUTHORIZED' : 'CATALOG_UNAVAILABLE',
                response.status,
            );
        }
        const value = result?.[action];
        const valid = action === 'services'
            ? Array.isArray(value) &&
                value.every((service) =>
                    Number.isSafeInteger(service?.service_id) && typeof service.name === 'string'
                )
            : action === 'cities'
            ? Array.isArray(value) && value.every((city) => typeof city === 'string')
            : value !== null && typeof value === 'object' && !Array.isArray(value) &&
                Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0);
        if (!valid) throw new CatalogApiError('CATALOG_UNAVAILABLE', response.status);
        return value;
    }

    return {
        getServices: () => request('services'),
        getAvailableServiceCounts: () => request('counts'),
        getAvailableCities: () => request('cities'),
    };
}

const client = createCatalogClient({
    url: APP_CONFIG.supabase.url,
    key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData,
    fetchImpl: (...args) => fetch(...args),
});

export const { getServices, getAvailableServiceCounts, getAvailableCities } = client;
