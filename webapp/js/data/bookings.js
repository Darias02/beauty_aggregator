import { sendNotification } from './notifications.js';
import { APP_CONFIG } from '../config.js';
import { getTelegramInitData } from '../telegram.js';

const readMessages = {
    UNAUTHORIZED: 'Откройте приложение заново через Telegram.',
    BOOKINGS_UNAVAILABLE: 'Не удалось загрузить записи. Попробуйте позже.',
};

export class BookingsApiError extends Error {
    constructor(code, status = 0) {
        super(readMessages[code] || readMessages.BOOKINGS_UNAVAILABLE);
        this.name = 'BookingsApiError';
        this.code = code;
        this.status = status;
    }
}

export function createBookingsReadClient({ url, key, getInitData, fetchImpl = globalThis.fetch }) {
    const validId = (id) => Number.isSafeInteger(id) && id > 0;
    const validBooking = (booking) => booking && validId(booking.booking_id) &&
        (booking.status === null || typeof booking.status === 'string') &&
        Object.hasOwn(booking, 'slots') && (booking.slots === null ||
            (validId(booking.slots.slot_id) && typeof booking.slots.date_time === 'string'));

    async function request(action, fields = {}) {
        const initData = getInitData();
        if (typeof initData !== 'string' || !initData) throw new BookingsApiError('UNAUTHORIZED', 401);
        let response;
        let result;
        try {
            response = await fetchImpl(`${url}/functions/v1/bookings-read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key },
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                body: JSON.stringify({ action, ...fields, init_data: initData }),
            });
            result = await response.json();
        } catch {
            throw new BookingsApiError('BOOKINGS_UNAVAILABLE');
        }
        if (!response.ok) {
            throw new BookingsApiError(response.status === 401 ? 'UNAUTHORIZED' : 'BOOKINGS_UNAVAILABLE', response.status);
        }
        if (!result || typeof result !== 'object') throw new BookingsApiError('BOOKINGS_UNAVAILABLE');
        return result;
    }

    async function getBooking(bookingId) {
        const { booking } = await request('booking', { booking_id: bookingId });
        if (booking !== null && (!validBooking(booking) || booking.booking_id !== Number(bookingId))) {
            throw new BookingsApiError('BOOKINGS_UNAVAILABLE');
        }
        return booking;
    }

    async function list(action) {
        const all = [];
        let before = null;
        while (true) {
            const result = await request(action, before === null ? {} : { before });
            if (!Array.isArray(result.bookings) || !result.bookings.every(validBooking)) {
                throw new BookingsApiError('BOOKINGS_UNAVAILABLE');
            }
            let previous = before ?? Infinity;
            for (const booking of result.bookings) {
                if (booking.booking_id >= previous) throw new BookingsApiError('BOOKINGS_UNAVAILABLE');
                previous = booking.booking_id;
            }
            const expected = result.bookings.length ? previous : null;
            if (result.next_cursor !== expected) throw new BookingsApiError('BOOKINGS_UNAVAILABLE');
            all.push(...result.bookings);
            if (expected === null) return all;
            before = expected;
        }
    }

    return {
        getBooking,
        // Preserve legacy arguments, but never send browser actor IDs to the API.
        getUserBookings: (_userId) => list('user'),
        getMasterBookings: (_masterId) => list('master'),
    };
}

const readClient = createBookingsReadClient({
    url: APP_CONFIG.supabase.url,
    key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData,
    fetchImpl: (...args) => fetch(...args),
});

export async function getBooking(bookingId) {
    return await readClient.getBooking(bookingId);
}

// Enrichment after BB-24 must use the owned booking: its slot is no longer public.
async function getSlot(bookingId) {
    return (await getBooking(bookingId))?.slots || null;
}

// Keep the screen API; userId is deliberately ignored as an authentication source.
export async function createBooking(_userId, slotId) {
    const initData = getTelegramInitData();
    if (!initData) throw new Error('Откройте приложение заново через Telegram.');

    let response;
    let result;
    try {
        response = await fetch(`${APP_CONFIG.supabase.url}/functions/v1/booking-create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: APP_CONFIG.supabase.key
            },
            body: JSON.stringify({ slot_id: slotId, init_data: initData })
        });
        result = await response.json();
    } catch {
        throw new Error('Не удалось отправить заявку. Попробуйте ещё раз.');
    }

    if (!response.ok) {
        // Only known public codes become UI messages; never display raw DB/gateway errors.
        const messages = {
            UNAUTHORIZED: 'Откройте приложение заново через Telegram.',
            PROFILE_NOT_FOUND: 'Создайте профиль перед записью.',
            SLOT_NOT_FOUND: 'Слот не найден.',
            SLOT_UNAVAILABLE: 'Этот слот уже недоступен.',
            SLOT_EXPIRED: 'Время этого слота уже прошло.',
            BOOKING_FORBIDDEN: 'Запись на этот слот недоступна.',
            INVALID_SLOT: 'Некорректный идентификатор слота.'
        };
        const code = result?.error?.code;
        throw new Error(Object.hasOwn(messages, code)
            ? messages[code]
            : 'Не удалось отправить заявку. Попробуйте ещё раз.');
    }

    const booking = result?.booking;
    if (!booking?.booking_id || typeof result.replayed !== 'boolean') {
        throw new Error('Не удалось получить результат записи. Попробуйте ещё раз.');
    }
    if (!result.replayed) {
        try {
            await sendNotification('notify-master', {
                type: 'booking_created',
                booking_id: booking.booking_id
            });
        } catch {
            console.warn('Booking saved; master notification failed.');
        }
    }

    // This is display enrichment only. The screen can use its selected slot if
    // the read fails; a committed booking must still be reported as successful.
    let slot = null;
    try {
        slot = await getSlot(booking.booking_id);
    } catch {
        console.warn('Booking saved; slot details are unavailable.');
    }
    return { ...booking, slot };
}

export async function getUserBookings(userId) {
    return await readClient.getUserBookings(userId);
}

export async function getMasterBookings(masterId) {
    return await readClient.getMasterBookings(masterId);
}

// BB-66: resource IDs only; BB-66/67 resolve the actor from signed initData.
export function createBookingsWriteClient({ url, key, getInitData, notify = sendNotification, fetchImpl = globalThis.fetch }) {
    async function decide(bookingId, action, reason = null) {
        const unavailable = () => new Error('Не удалось обработать заявку. Попробуйте ещё раз.');
        const initData = getInitData();
        if (typeof initData !== 'string' || !initData) throw new Error('Откройте приложение заново через Telegram.');
        let response, result;
        try {
            response = await fetchImpl(`${url}/functions/v1/bookings-write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key },
                cache: 'no-store', credentials: 'omit', redirect: 'error',
                body: JSON.stringify({ action, booking_id: bookingId, init_data: initData,
                    ...(action !== 'confirm' ? { reason } : {}) }),
            });
            result = await response.json();
        } catch { throw unavailable(); }
        if (!response.ok) {
            const messages = {
                UNAUTHORIZED: 'Откройте приложение заново через Telegram.',
                BOOKING_NOT_FOUND: 'Заявка не найдена.',
                BOOKING_CONFLICT: 'Заявка уже изменена или недоступна. Обновите список.',
                INVALID_REQUEST: 'Некорректные данные заявки.',
            };
            const code = result?.error?.code;
            throw new Error(Object.hasOwn(messages, code) ? messages[code] : unavailable().message);
        }
        const booking = result?.booking;
        if (!booking || booking.booking_id !== Number(bookingId) ||
            booking.status !== (action === 'confirm' ? 'Активна' : action === 'cancel' ? 'Отменена моделью' : 'Отменена мастером') ||
            booking.reason !== reason || typeof result.replayed !== 'boolean') throw unavailable();
        // Best effort, only for the transaction that changed state. A lost response
        // or closed browser can lose delivery; durable notifications need an outbox.
        if (!result.replayed) {
            try {
                await notify(action === 'cancel' ? 'notify-master' : 'notify-user', {
                    type: action === 'confirm' ? 'booking_confirmed' : action === 'cancel' ? 'model_cancelled' : 'booking_rejected',
                    booking_id: booking.booking_id,
                    ...(action === 'reject' ? { reason } : {}),
                });
            } catch { console.warn('Booking decision saved; notification failed.'); }
        }
        return booking;
    }
    return {
        confirmBooking: (id) => decide(id, 'confirm'),
        rejectBooking: (id, reason) => decide(id, 'reject', reason),
        cancelBooking: (id, reason) => decide(id, 'cancel', reason),
    };
}

const writeClient = createBookingsWriteClient({
    url: APP_CONFIG.supabase.url, key: APP_CONFIG.supabase.key,
    getInitData: getTelegramInitData, fetchImpl: (...args) => fetch(...args),
});

export async function confirmBooking(bookingId) {
    return await writeClient.confirmBooking(bookingId);
}

export async function rejectBooking(bookingId, reason) {
    return await writeClient.rejectBooking(bookingId, reason);
}

export async function cancelBooking(bookingId, reason) {
    if (!['time', 'other'].includes(reason)) {
        throw new Error('Укажите причину отмены.');
    }
    return await writeClient.cancelBooking(bookingId, reason);
}
