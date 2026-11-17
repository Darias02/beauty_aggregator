import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';

export interface Booking {
    booking_id: number;
    user_id: number;
    slot_id: number;
    status: string;
    reason: string | null;
}

export interface BookingRepository {
    book(userId: number, slotId: number): Promise<unknown>;
}

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => BookingRepository;
    nowSeconds?: () => number;
}

const headers = { ...corsHeaders, 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 16384;

class RequestError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function fail(status: number, code: string, message: string): never {
    throw new RequestError(status, code, message);
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function readBody(req: Request): Promise<unknown> {
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    }
    const reader = req.body?.getReader();
    if (!reader) fail(400, 'INVALID_REQUEST', 'JSON body is required.');
    const chunks: Uint8Array[] = [];
    let size = 0;
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

// Only documented BB-24 failures cross the API boundary, never DB details/hints.
function rpcFailure(error: unknown): never {
    if (object(error)) {
        const failures: [string, string, number, string, string][] = [
            ['PT404', 'BB24_USER_NOT_FOUND', 404, 'PROFILE_NOT_FOUND', 'Создайте профиль перед записью.'],
            ['PT404', 'BB24_SLOT_NOT_FOUND', 404, 'SLOT_NOT_FOUND', 'Слот не найден.'],
            ['PT409', 'BB24_SLOT_UNAVAILABLE', 409, 'SLOT_UNAVAILABLE', 'Этот слот уже недоступен.'],
            ['PT409', 'BB24_SLOT_EXPIRED', 409, 'SLOT_EXPIRED', 'Время этого слота уже прошло.'],
            ['PT409', 'BB24_INVALID_STATE', 409, 'SLOT_UNAVAILABLE', 'Этот слот уже недоступен.'],
            ['PT403', 'BB24_MODEL_REJECTED', 403, 'BOOKING_FORBIDDEN', 'Запись на этот слот недоступна.'],
            ['PT422', 'BB24_INVALID_ARGUMENT', 422, 'INVALID_SLOT', 'Некорректный идентификатор слота.'],
        ];
        for (const [dbCode, dbMessage, status, code, message] of failures) {
            if (error.code === dbCode && error.message === dbMessage) fail(status, code, message);
        }
    }
    throw new Error('Booking RPC failed');
}

export function createBookingHandler(dependencies: Dependencies) {
    return async (req: Request): Promise<Response> => {
        if (req.method === 'OPTIONS') return new Response('ok', { headers });
        if (req.method !== 'POST') {
            return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, {
                status: 405, headers: { ...headers, Allow: 'POST, OPTIONS' },
            });
        }
        try {
            if (new URL(req.url).search) fail(400, 'INVALID_REQUEST', 'Query parameters are not supported.');
            const body = await readBody(req);
            if (!object(body)) fail(400, 'INVALID_REQUEST', 'Body must be an object.');
            const botToken = dependencies.env('BOT_TOKEN');
            if (!botToken) fail(503, 'SERVER_NOT_CONFIGURED', 'Booking service is not configured.');
            const actor = await validateInitData(body.init_data, botToken, {
                nowSeconds: dependencies.nowSeconds?.(),
            });
            if (!actor) fail(401, 'UNAUTHORIZED', 'Откройте приложение заново через Telegram.');
            if (Object.keys(body).some((key) => !['init_data', 'slot_id'].includes(key))) {
                fail(400, 'INVALID_REQUEST', 'Unknown or forbidden field.');
            }
            if (!positiveId(body.slot_id)) fail(422, 'INVALID_SLOT', 'Некорректный идентификатор слота.');

            let key: string;
            try {
                key = getAdminKey(dependencies.env);
            } catch {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Booking service is not configured.');
            }
            const url = dependencies.env('SUPABASE_URL');
            if (!url || !key.trim()) fail(503, 'SERVER_NOT_CONFIGURED', 'Booking service is not configured.');
            const repository = dependencies.createRepository(url, key);
            let result: unknown;
            try {
                result = await repository.book(actor.id, body.slot_id);
            } catch (error) {
                rpcFailure(error);
            }
            // Fail closed on a broken RPC contract; do not return someone else's row.
            if (!object(result) || typeof result.replayed !== 'boolean' || !object(result.booking)) {
                throw new Error('Invalid booking result');
            }
            const booking = result.booking;
            if (!positiveId(booking.booking_id) || booking.user_id !== actor.id ||
                booking.slot_id !== body.slot_id ||
                !['Ожидает подтверждения мастера', 'Активна'].includes(String(booking.status)) ||
                !(booking.reason === null || typeof booking.reason === 'string')) {
                throw new Error('Invalid booking result');
            }
            return Response.json({
                booking: {
                    booking_id: booking.booking_id, user_id: actor.id, slot_id: body.slot_id,
                    status: booking.status, reason: booking.reason,
                },
                replayed: result.replayed,
            }, { headers });
        } catch (error) {
            if (error instanceof RequestError) {
                return Response.json({ error: { code: error.code, message: error.message } }, {
                    status: error.status, headers,
                });
            }
            return Response.json({ error: {
                code: 'BOOKING_UNAVAILABLE', message: 'Не удалось отправить заявку. Попробуйте ещё раз.',
            } }, { status: 500, headers });
        }
    };
}
