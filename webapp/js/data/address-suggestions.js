import { APP_CONFIG } from '../config.js';
import { getTelegramInitData } from '../telegram.js';

/** @param {{url: string, key: string, getInitData: () => string, fetchImpl?: typeof fetch}} options */
export function createAddressSuggestionsClient(
    { url, key, getInitData, fetchImpl = globalThis.fetch },
) {
    /** @param {{mode: 'city'|'address', query: string, city?: string, cityId?: string|null, signal?: AbortSignal}} input */
    return async function suggest({ mode, query, city = '', cityId = null, signal }) {
        const initData = getInitData();
        if (!initData) throw new Error('UNAUTHORIZED');
        const response = await fetchImpl(`${url}/functions/v1/address-suggest`, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal,
            headers: { 'Content-Type': 'application/json', apikey: key },
            body: JSON.stringify({
                init_data: initData,
                mode,
                query,
                ...(mode === 'address' && city
                    ? { city, ...(cityId ? { city_id: cityId } : {}) }
                    : {}),
            }),
        });
        if (!response.ok) throw new Error('SUGGESTIONS_UNAVAILABLE');
        const result = await response.json();
        if (
            !Array.isArray(result?.suggestions) || result.suggestions.length > 5 ||
            !result.suggestions.every((item) =>
                item && typeof item.label === 'string' && item.label.length <= 500 &&
                typeof item.value === 'string' && item.value.length <= 500 &&
                (item.cityId === null || typeof item.cityId === 'string')
            )
        ) {
            throw new Error('SUGGESTIONS_UNAVAILABLE');
        }
        return result.suggestions;
    };
}

export const suggestAddress = createAddressSuggestionsClient({
    url: APP_CONFIG.supabase.url,
    key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData,
    fetchImpl: (...args) => fetch(...args),
});
