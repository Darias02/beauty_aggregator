import { APP_CONFIG } from '../config.js';
import { getTelegramInitData } from '../telegram.js';

const messages = {
    UNAUTHORIZED: 'Авторизация отсутствует или истекла. Откройте приложение заново через Telegram.',
    SLOTS_WRITE_UNAVAILABLE: 'Не удалось сохранить изменения слота. Попробуйте позже.',
    SLOT_DUPLICATE: 'Слот на это время уже существует.',
    SLOT_EXPIRED: 'Нельзя создать слот в прошлом.',
    SLOT_NOT_FOUND: 'Слот или профиль мастера не найден.',
    SLOT_UNAVAILABLE: 'Слот недоступен для этой операции. Обновите список и попробуйте снова.',
    SLOT_HAS_HISTORY: 'Нельзя удалить слот с историей записей. История сохранена.',
    INVALID_REQUEST: 'Проверьте услугу, город, дату, время, адрес и описание.',
    SLOTS_UNAVAILABLE: 'Не удалось загрузить слоты. Попробуйте позже.',
};

export class SlotsApiError extends Error {
    constructor(code, status = 0) {
        super(messages[code] || messages.SLOTS_UNAVAILABLE);
        this.name = 'SlotsApiError';
        this.code = code;
        this.status = status;
    }
}

export function createSlotsReadClient({ url, key, getInitData, fetchImpl = globalThis.fetch }) {
    async function request(action, fields = {}) {
        const initData = getInitData();
        if (typeof initData !== 'string' || !initData) {
            throw new SlotsApiError('UNAUTHORIZED', 401);
        }
        let response;
        let result;
        try {
            response = await fetchImpl(`${url}/functions/v1/slots-read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key },
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                body: JSON.stringify({ action, ...fields, init_data: initData }),
            });
            result = await response.json();
        } catch {
            throw new SlotsApiError('SLOTS_UNAVAILABLE');
        }
        if (!response.ok) {
            throw new SlotsApiError(
                response.status === 401 ? 'UNAUTHORIZED' : 'SLOTS_UNAVAILABLE',
                response.status,
            );
        }
        const value = action === 'slot' ? result?.slot : result?.slots;
        const validSlot = (slot) => slot && Number.isSafeInteger(slot.slot_id) &&
            typeof slot.date_time === 'string' && (slot.status === null || typeof slot.status === 'string');
        if (action === 'slot' ? value !== null && !validSlot(value)
            : !Array.isArray(value) || !value.every(validSlot)) {
            throw new SlotsApiError('SLOTS_UNAVAILABLE', response.status);
        }
        return value;
    }

    return {
        // Legacy actor arguments remain accepted by JS callers but never leave the browser.
        getAvailableSlots: (serviceId, city = null, _userId = null) => !serviceId
            ? Promise.resolve([]) : request('available', { service_id: serviceId, city }),
        getSlot: (slotId) => request('slot', { slot_id: slotId }),
        getMasterSlots: (_masterId) => request('master'),
    };
}

const client = createSlotsReadClient({
    url: APP_CONFIG.supabase.url,
    key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData,
    fetchImpl: (...args) => fetch(...args),
});

export const { getAvailableSlots, getSlot, getMasterSlots } = client;

export function createSlotsWriteClient({ url, key, getInitData, fetchImpl = globalThis.fetch }) {
    async function request(action, fields) {
        const initData = getInitData();
        if (typeof initData !== 'string' || !initData) throw new SlotsApiError('UNAUTHORIZED', 401);
        let response;
        let result;
        try {
            response = await fetchImpl(`${url}/functions/v1/slots-write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key },
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                body: JSON.stringify({ action, ...fields, init_data: initData }),
            });
            result = await response.json();
        } catch {
            throw new SlotsApiError('SLOTS_WRITE_UNAVAILABLE');
        }
        if (!response.ok) {
            const code = response.status === 401 ? 'UNAUTHORIZED' : result?.error?.code;
            throw new SlotsApiError(
                Object.hasOwn(messages, code) ? code : 'SLOTS_WRITE_UNAVAILABLE',
                response.status,
            );
        }
        if (action === 'cancel') {
            if (result?.deleted === true && !Object.hasOwn(result, 'booking')) {
                return { deleted: true };
            }
            const booking = result?.booking;
            if (result?.deleted !== false || !booking ||
                !Number.isSafeInteger(booking.booking_id) || booking.booking_id <= 0 ||
                booking.slot_id !== Number(fields.slot_id) ||
                booking.status !== 'Отменена мастером' || booking.reason !== 'plans') {
                throw new SlotsApiError('SLOTS_WRITE_UNAVAILABLE');
            }
            return { deleted: false, booking };
        }
        if (action === 'delete') {
            if (result?.deleted !== true) throw new SlotsApiError('SLOTS_WRITE_UNAVAILABLE');
            return;
        }
        const slot = result?.slot;
        if (!slot || !Number.isSafeInteger(slot.slot_id) || slot.slot_id <= 0 ||
            typeof slot.date_time !== 'string' || slot.status !== 'Свободен') {
            throw new SlotsApiError('SLOTS_WRITE_UNAVAILABLE');
        }
        return slot;
    }
    return {
        // Preserve the UI signatures; the legacy masterId is deliberately ignored.
        createSlot: ({ masterId: _masterId, serviceId, dateTime, city, address = '', description = '' }) =>
            request('create', { service_id: serviceId, date_time: dateTime, city, address, description }),
        deleteSlot: (slotId, _masterId) => request('delete', { slot_id: slotId }),
        cancelSlot: (slotId, _masterId) => request('cancel', { slot_id: slotId }),
    };
}

const writeClient = createSlotsWriteClient({
    url: APP_CONFIG.supabase.url,
    key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData,
    fetchImpl: (...args) => fetch(...args),
});

export const { createSlot, deleteSlot, cancelSlot } = writeClient;
