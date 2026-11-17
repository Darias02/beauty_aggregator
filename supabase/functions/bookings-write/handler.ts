import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';

import { validDecision } from './repository.ts';
import type { BookingsWriteRepository } from './repository.ts';

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => BookingsWriteRepository;
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

export function createBookingsWriteHandler(dependencies: Dependencies) {
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
            if (action !== 'confirm' && action !== 'reject' && action !== 'cancel') {
                fail(400, 'INVALID_REQUEST', 'Unknown action.');
            }
            allowedKeys(body, action === 'confirm'
                ? ['init_data', 'action', 'booking_id']
                : ['init_data', 'action', 'booking_id', 'reason']);
            if (!positiveId(body.booking_id) ||
                (action === 'reject' && body.reason !== 'model' && body.reason !== 'plans') ||
                (action === 'cancel' && body.reason !== 'time' && body.reason !== 'other')) {
                fail(400, 'INVALID_REQUEST', 'Invalid booking decision.');
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
            const reason = action === 'confirm' ? null : body.reason as 'model' | 'plans' | 'time' | 'other';
            const result = await repository.decide(actor.id, Number(body.booking_id), action, reason);
            if (!validDecision(result, Number(body.booking_id), action, reason) ||
                (action === 'cancel' && result.booking.user_id !== actor.id)) {
                throw new Error('Invalid booking decision result');
            }
            return Response.json(result, { headers });
        } catch (error) {
            if (error instanceof RequestError) {
                return Response.json({ error: { code: error.code, message: error.message } }, {
                    status: error.status,
                    headers,
                });
            }
            const code = object(error) ? error.code : undefined;
            const known: Record<string, [number, string]> = {
                PT404: [404, 'BOOKING_NOT_FOUND'],
                PT409: [409, 'BOOKING_CONFLICT'],
                PT422: [400, 'INVALID_REQUEST'],
            };
            const failure = typeof code === 'string' && Object.hasOwn(known, code) ? known[code] : null;
            return Response.json({ error: {
                code: failure?.[1] ?? 'BOOKINGS_UNAVAILABLE',
                message: 'Booking decision could not be completed.',
            } }, { status: failure?.[0] ?? 500, headers });
        }
    };
}
