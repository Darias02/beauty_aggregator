import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';
import type { TelegramUser } from '../_shared/telegram.ts';

export interface Profile {
    user_id: number;
    name: string;
}

export interface ProfileRepository {
    get(userId: number): Promise<Profile | null>;
    ensure(userId: number, name: string): Promise<Profile>;
    updateName(userId: number, name: string): Promise<Profile | null>;
}

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => ProfileRepository;
    nowSeconds?: () => number;
}

const MAX_BODY_BYTES = 16384;
const MAX_NAME_LENGTH = 100;
const forbiddenNameCharacters = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
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

function validateName(value: unknown): string {
    if (typeof value !== 'string') fail(400, 'INVALID_NAME', 'Name must be a string.');
    const name = value.trim();
    if (!name || [...name].length > MAX_NAME_LENGTH || forbiddenNameCharacters.test(value)) {
        fail(400, 'INVALID_NAME', 'Name must contain 1 to 100 printable characters.');
    }
    return name;
}

function initialName(actor: TelegramUser): string {
    const value = actor.username
        ? `@${actor.username}`
        : [actor.first_name, actor.last_name].filter(Boolean).join(' ');
    const name = value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').trim();
    return [...name].slice(0, MAX_NAME_LENGTH).join('') || 'Никнейм';
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

export function createProfileHandler(dependencies: Dependencies) {
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
            if (!botToken) fail(503, 'SERVER_NOT_CONFIGURED', 'Profile service is not configured.');
            const actor = await validateInitData(body.init_data, botToken, {
                nowSeconds: dependencies.nowSeconds?.(),
            });
            if (!actor) fail(401, 'UNAUTHORIZED', 'Invalid or expired Telegram authorization.');

            allowedKeys(body, ['init_data', 'action', 'profile']);
            const action = body.action;
            if (typeof action !== 'string' || !['get', 'ensure', 'update'].includes(action)) {
                fail(400, 'INVALID_REQUEST', 'Unknown action.');
            }
            let name: string | undefined;
            if (action === 'update') {
                if (!object(body.profile)) {
                    fail(400, 'INVALID_REQUEST', 'Profile patch is required.');
                }
                allowedKeys(body.profile, ['name']);
                name = validateName(body.profile.name);
            } else if ('profile' in body) {
                fail(400, 'INVALID_REQUEST', 'Profile fields are only accepted for updates.');
            }

            let key: string;
            try {
                key = getAdminKey(dependencies.env);
            } catch {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Profile service is not configured.');
            }
            const url = dependencies.env('SUPABASE_URL');
            if (!key.trim() || !url) {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Profile service is not configured.');
            }

            const repository = dependencies.createRepository(url, key);
            const profile = action === 'get'
                ? await repository.get(actor.id)
                : action === 'ensure'
                ? await repository.ensure(actor.id, initialName(actor))
                : await repository.updateName(actor.id, name!);
            if (!profile) fail(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
            if (profile.user_id !== actor.id || typeof profile.name !== 'string') {
                throw new Error('Invalid profile result');
            }
            return Response.json({ profile: { user_id: actor.id, name: profile.name } }, {
                headers,
            });
        } catch (error) {
            if (error instanceof RequestError) {
                return Response.json({ error: { code: error.code, message: error.message } }, {
                    status: error.status,
                    headers,
                });
            }
            return Response.json({
                error: { code: 'PROFILE_UNAVAILABLE', message: 'Profile service is unavailable.' },
            }, {
                status: 500,
                headers,
            });
        }
    };
}
