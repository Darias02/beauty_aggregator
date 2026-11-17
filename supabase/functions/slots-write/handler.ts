import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';

import type { SlotInput, SlotsWriteRepository } from './repository.ts';

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => SlotsWriteRepository;
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

// IDs select resources only; identity, status and permissions are never request fields.
function textField(value: unknown, max: number, required = false): string {
    if (typeof value !== 'string') fail(400, 'INVALID_REQUEST', 'Invalid text field.');
    const text = value.trim();
    // Reject control and bidi characters intentionally; keep ordinary whitespace allowed.
    if ((required && (!text || text === 'Город')) || [...text].length > max ||
        // deno-lint-ignore no-control-regex
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
        fail(400, 'INVALID_REQUEST', 'Invalid text field.');
    }
    return text;
}

function dateTime(value: unknown, now: number): string {
    if (typeof value !== 'string') fail(400, 'INVALID_REQUEST', 'Invalid date/time.');
    // Require an explicit timezone. Date.parse alone silently normalizes February 30.
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!parts) fail(400, 'INVALID_REQUEST', 'Invalid date/time.');
    const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const timestamp = Date.parse(value);
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
        Number(offsetHour || 0) > 23 || Number(offsetMinute || 0) > 59 ||
        !Number.isFinite(timestamp)) {
        fail(400, 'INVALID_REQUEST', 'Invalid date/time.');
    }
    if (timestamp <= now * 1000) fail(409, 'SLOT_EXPIRED', 'Slot must be in the future.');
    return new Date(timestamp).toISOString();
}

export function createSlotsWriteHandler(dependencies: Dependencies) {
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
            if (!botToken) fail(503, 'SERVER_NOT_CONFIGURED', 'Slots service is not configured.');
            const actor = await validateInitData(body.init_data, botToken, {
                nowSeconds: dependencies.nowSeconds?.(),
            });
            if (!actor) fail(401, 'UNAUTHORIZED', 'Invalid or expired Telegram authorization.');
            const action = body.action;
            let input: SlotInput | undefined;
            if (action === 'create') {
                allowedKeys(body, [
                    'init_data', 'action', 'service_id', 'date_time', 'city', 'address', 'description',
                ]);
                if (!positiveId(body.service_id)) fail(400, 'INVALID_REQUEST', 'Invalid service ID.');
                input = {
                    service_id: Number(body.service_id),
                    date_time: dateTime(
                        body.date_time, dependencies.nowSeconds?.() ?? Date.now() / 1000,
                    ),
                    city: textField(body.city, 200, true),
                    address: textField(body.address === undefined ? '' : body.address, 500),
                    description: textField(body.description === undefined ? '' : body.description, 2000),
                };
            } else if (action === 'delete' || action === 'cancel') {
                allowedKeys(body, ['init_data', 'action', 'slot_id']);
                if (!positiveId(body.slot_id)) fail(400, 'INVALID_REQUEST', 'Invalid slot ID.');
            } else {
                fail(400, 'INVALID_REQUEST', 'Unknown action.');
            }

            let key: string;
            try {
                key = getAdminKey(dependencies.env);
            } catch {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Slots service is not configured.');
            }
            const url = dependencies.env('SUPABASE_URL');
            if (!key.trim() || !url) {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Slots service is not configured.');
            }
            const repository = dependencies.createRepository(url, key);
            if (action === 'create' && input) {
                const slot = await repository.create(actor.id, input);
                if (!slot || slot.master_id !== actor.id || slot.status !== 'Свободен' ||
                    !positiveId(slot.slot_id)) {
                    throw new Error('Invalid slot result');
                }
                return Response.json({ slot }, { headers });
            }
            if (action === 'cancel') {
                const result = await repository.cancel(actor.id, Number(body.slot_id));
                return Response.json(result, { headers });
            }
            await repository.delete(actor.id, Number(body.slot_id));
            return Response.json({ deleted: true }, { headers });
        } catch (error) {
            if (error instanceof RequestError) {
                return Response.json({ error: { code: error.code, message: error.message } }, {
                    status: error.status,
                    headers,
                });
            }
            const code = object(error) ? error.code : undefined;
            if (code === 'PT409' && object(error) && error.message === 'BB73_SLOT_HAS_HISTORY') {
                return Response.json({
                    error: {
                        code: 'SLOT_HAS_HISTORY',
                        message: 'A slot with booking history cannot be deleted.',
                    },
                }, { status: 409, headers });
            }
            const known: Record<string, [number, string]> = {
                PT404: [404, 'SLOT_NOT_FOUND'],
                PT409: [409, 'SLOT_UNAVAILABLE'],
                PT422: [400, 'INVALID_REQUEST'],
                PT410: [409, 'SLOT_EXPIRED'],
            };
            const failure = typeof code === 'string' && Object.hasOwn(known, code)
                ? known[code] : undefined;
            if (failure) {
                return Response.json({
                    error: { code: failure[1], message: 'Slot operation rejected.' },
                }, { status: failure[0], headers });
            }
            if (code === '23505' && object(error) && typeof error.message === 'string' &&
                error.message.includes('slots_one_live_time_per_master')) {
                return Response.json({ error: { code: 'SLOT_DUPLICATE', message: 'Slot already exists.' } }, { status: 409, headers });
            }
            return Response.json({
                error: { code: 'SLOTS_UNAVAILABLE', message: 'Slots service is unavailable.' },
            }, { status: 500, headers });
        }
    };
}
