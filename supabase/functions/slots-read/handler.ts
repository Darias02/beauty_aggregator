import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';

import type { Slot, SlotsRepository } from './repository.ts';

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => SlotsRepository;
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

// Explicit UI contract: no booking, contact or future table columns can leak.
function publicSlot(slot: Slot): Slot {
    return {
        slot_id: slot.slot_id,
        date_time: slot.date_time,
        status: slot.status,
        master_id: slot.master_id,
        service_id: slot.service_id,
        city: slot.city,
        address: slot.address,
        description: slot.description,
        services: slot.services
            ? { service_id: slot.services.service_id, name: slot.services.name }
            : null,
    };
}

export function createSlotsHandler(dependencies: Dependencies) {
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
            if (action === 'available') {
                allowedKeys(body, ['init_data', 'action', 'service_id', 'city']);
                if (!positiveId(body.service_id)) {
                    fail(400, 'INVALID_REQUEST', 'Invalid service ID.');
                }
                if (
                    body.city != null && (typeof body.city !== 'string' || body.city.length > 200)
                ) {
                    fail(400, 'INVALID_REQUEST', 'Invalid city.');
                }
            } else if (action === 'slot') {
                allowedKeys(body, ['init_data', 'action', 'slot_id']);
                if (!positiveId(body.slot_id)) fail(400, 'INVALID_REQUEST', 'Invalid slot ID.');
            } else if (action === 'master') {
                allowedKeys(body, ['init_data', 'action']);
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
            const now = new Date((dependencies.nowSeconds?.() ?? Date.now() / 1000) * 1000)
                .toISOString();
            if (action === 'available') {
                const slots = await repository.getAvailableSlots(
                    actor.id,
                    Number(body.service_id),
                    typeof body.city === 'string' && body.city && body.city !== 'Город'
                        ? body.city
                        : null,
                    now,
                );
                return Response.json({ slots: slots.map(publicSlot) }, { headers });
            }
            if (action === 'slot') {
                const slot = await repository.getSlot(actor.id, Number(body.slot_id), now);
                return Response.json({ slot: slot ? publicSlot(slot) : null }, { headers });
            }
            const slots = await repository.getMasterSlots(actor.id);
            return Response.json({ slots: slots.map(publicSlot) }, { headers });
        } catch (error) {
            if (error instanceof RequestError) {
                return Response.json({ error: { code: error.code, message: error.message } }, {
                    status: error.status,
                    headers,
                });
            }
            return Response.json({
                error: { code: 'SLOTS_UNAVAILABLE', message: 'Slots service is unavailable.' },
            }, { status: 500, headers });
        }
    };
}
