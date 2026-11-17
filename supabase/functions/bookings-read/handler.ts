import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';

import type { Booking, BookingsRepository } from './repository.ts';

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => BookingsRepository;
    nowSeconds?: () => number;
}

const MAX_BODY_BYTES = 16384;
const headers = { ...corsHeaders, 'Cache-Control': 'no-store' };

class RequestError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

function fail(status: number, code: string, message: string): never {
    throw new RequestError(status, code, message);
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allowedKeys(value: Record<string, unknown>, keys: string[]) {
    if (Object.keys(value).some((key) => !keys.includes(key))) {
        fail(400, 'INVALID_REQUEST', 'Unknown or forbidden field.');
    }
}

async function readBody(req: Request): Promise<unknown> {
    if (
        req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    ) {
        fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    }
    const reader = req.body?.getReader();
    if (!reader) fail(400, 'INVALID_REQUEST', 'JSON body is required.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
                await reader.cancel();
                fail(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        fail(400, 'INVALID_REQUEST', 'Invalid JSON body.');
    }
}

function positiveId(value: unknown): boolean {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
        (typeof value === 'string' && /^[1-9]\d*$/.test(value) &&
            Number.isSafeInteger(Number(value)));
}

// Explicit projection also protects against future columns returned by a repository.
function publicBooking(booking: Booking, actorId: number, role?: 'user' | 'master'): Booking {
    const owned = role === 'user' ? booking.user_id === actorId
        : role === 'master' ? booking.slots?.master_id === actorId
        : booking.user_id === actorId || booking.slots?.master_id === actorId;
    if (!owned) throw new Error('Invalid booking ownership');
    const slot = booking.slots;
    return {
        booking_id: booking.booking_id,
        user_id: booking.user_id,
        slot_id: booking.slot_id,
        status: booking.status,
        reason: booking.reason,
        slots: slot ? {
            slot_id: slot.slot_id,
            master_id: slot.master_id,
            service_id: slot.service_id,
            date_time: slot.date_time,
            status: slot.status,
            city: slot.city,
            address: slot.address,
            description: slot.description,
            services: slot.services
                ? { service_id: slot.services.service_id, name: slot.services.name }
                : null,
        } : null,
    };
}

export function createBookingsHandler(dependencies: Dependencies) {
    return async (req: Request): Promise<Response> => {
        if (req.method === 'OPTIONS') return new Response('ok', { headers });
        if (req.method !== 'POST') {
            return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, {
                status: 405,
                headers: { ...headers, Allow: 'POST, OPTIONS' },
            });
        }
        try {
            if (new URL(req.url).search) {
                fail(400, 'INVALID_REQUEST', 'Query parameters are not supported.');
            }
            const body = await readBody(req);
            if (!object(body)) fail(400, 'INVALID_REQUEST', 'Body must be an object.');
            if (typeof body.init_data !== 'string' || !body.init_data) {
                fail(401, 'UNAUTHORIZED', 'Telegram authorization is required.');
            }
            const botToken = dependencies.env('BOT_TOKEN');
            if (!botToken) fail(503, 'SERVER_NOT_CONFIGURED', 'Bookings service is not configured.');
            const actor = await validateInitData(body.init_data, botToken, {
                nowSeconds: dependencies.nowSeconds?.(),
            });
            if (!actor) fail(401, 'UNAUTHORIZED', 'Invalid or expired Telegram authorization.');
            const action = body.action;
            if (action === 'booking') {
                allowedKeys(body, ['init_data', 'action', 'booking_id']);
                if (!positiveId(body.booking_id)) fail(400, 'INVALID_REQUEST', 'Invalid booking ID.');
            } else if (action === 'user' || action === 'master') {
                allowedKeys(body, ['init_data', 'action', 'before']);
                if (body.before != null && !positiveId(body.before)) {
                    fail(400, 'INVALID_REQUEST', 'Invalid pagination cursor.');
                }
            } else {
                fail(400, 'INVALID_REQUEST', 'Unknown action.');
            }

            let key: string;
            try {
                key = getAdminKey(dependencies.env);
            } catch {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Bookings service is not configured.');
            }
            const url = dependencies.env('SUPABASE_URL');
            if (!key.trim() || !url) {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Bookings service is not configured.');
            }
            const repository = dependencies.createRepository(url, key);
            if (action === 'booking') {
                const booking = await repository.getBooking(actor.id, Number(body.booking_id));
                if (booking && booking.booking_id !== Number(body.booking_id)) {
                    throw new Error('Invalid booking ID');
                }
                return Response.json({ booking: booking ? publicBooking(booking, actor.id) : null }, { headers });
            }
            const role = action as 'user' | 'master';
            const before = body.before == null ? null : Number(body.before);
            const rows = await repository.getPage(actor.id, role, before);
            let previous = before ?? Infinity;
            const bookings = rows.map((row) => {
                if (!positiveId(row.booking_id) || row.booking_id >= previous) {
                    throw new Error('Invalid page order');
                }
                previous = row.booking_id;
                return publicBooking(row, actor.id, role);
            });
            // Do not infer EOF from a short page: the server may cap below our limit.
            return Response.json({
                bookings,
                next_cursor: bookings.length ? bookings[bookings.length - 1].booking_id : null,
            }, { headers });
        } catch (error) {
            if (error instanceof RequestError) {
                return Response.json({ error: { code: error.code, message: error.message } }, {
                    status: error.status,
                    headers,
                });
            }
            return Response.json({
                error: { code: 'BOOKINGS_UNAVAILABLE', message: 'Bookings service is unavailable.' },
            }, { status: 500, headers });
        }
    };
}
