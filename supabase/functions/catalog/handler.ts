import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';

export interface Service {
    service_id: number;
    name: string;
    icon_url: string | null;
    duration: string | number | null;
    description: string | null;
}

export interface CatalogRepository {
    getServices(): Promise<Service[]>;
    getAvailableServiceCounts(): Promise<Record<string, number>>;
    getAvailableCities(): Promise<string[]>;
}

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => CatalogRepository;
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

export function createCatalogHandler(dependencies: Dependencies) {
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
            if (!botToken) fail(503, 'SERVER_NOT_CONFIGURED', 'Catalog service is not configured.');
            const actor = await validateInitData(body.init_data, botToken, {
                nowSeconds: dependencies.nowSeconds?.(),
            });
            if (!actor) fail(401, 'UNAUTHORIZED', 'Invalid or expired Telegram authorization.');
            allowedKeys(body, ['init_data', 'action']);
            const action = body.action;
            if (typeof action !== 'string' || !['services', 'counts', 'cities'].includes(action)) {
                fail(400, 'INVALID_REQUEST', 'Unknown action.');
            }

            let key: string;
            try {
                key = getAdminKey(dependencies.env);
            } catch {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Catalog service is not configured.');
            }
            const url = dependencies.env('SUPABASE_URL');
            if (!key.trim() || !url) {
                fail(503, 'SERVER_NOT_CONFIGURED', 'Catalog service is not configured.');
            }
            const repository = dependencies.createRepository(url, key);
            if (action === 'services') {
                const services = await repository.getServices();
                return Response.json({
                    services: services.map((service) => ({
                        service_id: service.service_id,
                        name: service.name,
                        icon_url: service.icon_url,
                        duration: service.duration,
                        description: service.description,
                    })),
                }, { headers });
            }
            if (action === 'counts') {
                return Response.json({ counts: await repository.getAvailableServiceCounts() }, {
                    headers,
                });
            }
            return Response.json({ cities: await repository.getAvailableCities() }, { headers });
        } catch (error) {
            if (error instanceof RequestError) {
                return Response.json({ error: { code: error.code, message: error.message } }, {
                    status: error.status,
                    headers,
                });
            }
            return Response.json({
                error: { code: 'CATALOG_UNAVAILABLE', message: 'Catalog service is unavailable.' },
            }, { status: 500, headers });
        }
    };
}
