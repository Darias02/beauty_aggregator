import { corsHeaders, validateInitData } from '../_shared/telegram.ts';

const ENDPOINT = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const headers = { ...corsHeaders, 'Cache-Control': 'no-store' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const forbidden = /[\p{Cc}\p{Cf}]/u;
interface Dependencies {
    env: (name: string) => string | undefined;
    fetchImpl?: typeof fetch;
    nowSeconds?: () => number;
}

class Rejected extends Error {
    constructor(readonly status: number, readonly code: string) {
        super(code);
    }
}
function reject(status: number, code: string): never {
    throw new Rejected(status, code);
}
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number, min = 0): string {
    if (typeof value !== 'string' || forbidden.test(value)) reject(400, 'INVALID_REQUEST');
    const result = value.trim();
    if ([...result].length < min || [...result].length > max) reject(400, 'INVALID_REQUEST');
    return result;
}

// Limits streams as well as declared Content-Length. Never echo provider errors or credentials.
async function boundedJson(
    stream: ReadableStream<Uint8Array> | null,
    max: number,
): Promise<unknown> {
    if (!stream) throw new Error('Empty body');
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > max) throw new Error('Body too large');
            chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function createAddressSuggestHandler(dependencies: Dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    // Best effort, per isolate ONLY. The provider's FREE subscription enforces the
    // shared daily ceiling. These counters are NOT a distributed per-user limiter.
    const users = new Map<number, { minute: number; count: number }>();
    let instance = { minute: -1, count: 0 };
    function admit(id: number, now: number) {
        const minute = Math.floor(now / 60);
        if (instance.minute !== minute) {
            instance = { minute, count: 0 };
            users.clear();
        }
        const user = users.get(id) ?? { minute, count: 0 };
        if (user.count >= 30 || instance.count >= 200) reject(429, 'RATE_LIMITED');
        user.count++;
        instance.count++;
        users.set(id, user);
    }
    return async (req: Request): Promise<Response> => {
        if (req.method === 'OPTIONS') return new Response('ok', { headers });
        try {
            if (req.method !== 'POST') reject(405, 'METHOD_NOT_ALLOWED');
            if (
                new URL(req.url).search ||
                req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
            ) {
                reject(400, 'INVALID_REQUEST');
            }
            let body: unknown;
            try {
                body = await boundedJson(req.body, 16384);
            } catch {
                reject(400, 'INVALID_REQUEST');
            }
            if (!object(body)) reject(400, 'INVALID_REQUEST');
            const token = dependencies.env('BOT_TOKEN');
            if (!token) reject(503, 'SUGGESTIONS_UNAVAILABLE');
            const now = dependencies.nowSeconds?.() ?? Date.now() / 1000;
            const actor = await validateInitData(body.init_data, token, { nowSeconds: now });
            if (!actor) reject(401, 'UNAUTHORIZED');
            if (
                Object.keys(body).some((key) =>
                    !['init_data', 'mode', 'query', 'city', 'city_id'].includes(key)
                )
            ) {
                reject(400, 'INVALID_REQUEST');
            }
            const mode = body.mode;
            if (mode !== 'city' && mode !== 'address') reject(400, 'INVALID_REQUEST');
            const query = text(body.query, 200, 2);
            const city = body.city === undefined ? '' : text(body.city, 200);
            const cityId = body.city_id;
            if (cityId !== undefined && (typeof cityId !== 'string' || !uuid.test(cityId))) {
                reject(400, 'INVALID_REQUEST');
            }
            if ((mode === 'city' && (city || cityId)) || (cityId && !city)) {
                reject(400, 'INVALID_REQUEST');
            }
            const key = dependencies.env('DADATA_API_KEY');
            // Explicit opt-in documents that this token belongs to a FREE account.
            if (!key || dependencies.env('DADATA_FREE_TIER_ENABLED') !== 'true') {
                reject(503, 'SUGGESTIONS_UNAVAILABLE');
            }
            admit(actor.id, now);
            const payload = {
                query,
                count: 5,
                language: 'ru',
                locations: [
                    mode === 'address' && city
                        ? (cityId
                            ? { country_iso_code: 'RU', city_fias_id: cityId }
                            : { country_iso_code: 'RU', city })
                        : { country_iso_code: 'RU' },
                ],
                ...(mode === 'city'
                    ? { from_bound: { value: 'city' }, to_bound: { value: 'city' } }
                    : {}),
            };
            const response = await fetchImpl(ENDPOINT, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(3000),
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Token ${key}`,
                },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                await response.body?.cancel();
                reject(
                    response.status === 429 ? 429 : 503,
                    response.status === 429 ? 'RATE_LIMITED' : 'SUGGESTIONS_UNAVAILABLE',
                );
            }
            const result = await boundedJson(response.body, 131072);
            if (!object(result) || !Array.isArray(result.suggestions)) {
                throw new Error('Invalid provider response');
            }
            const suggestions = [];
            for (const item of result.suggestions.slice(0, 5)) {
                if (!object(item) || !object(item.data) || item.data.country_iso_code !== 'RU') {
                    continue;
                }
                const label = item.value;
                const value = mode === 'city' ? item.data.city : item.value;
                if (
                    typeof label !== 'string' || !label.trim() || label.length > 500 ||
                    forbidden.test(label) ||
                    typeof value !== 'string' || !value.trim() ||
                    [...value].length > (mode === 'city' ? 200 : 500) || forbidden.test(value)
                ) continue;
                const id = item.data.city_fias_id;
                suggestions.push({
                    label: label.trim(),
                    value: value.trim(),
                    cityId: typeof id === 'string' && uuid.test(id) ? id : null,
                });
            }
            return Response.json({ suggestions }, { headers });
        } catch (error) {
            const failure = error instanceof Rejected
                ? error
                : new Rejected(503, 'SUGGESTIONS_UNAVAILABLE');
            return Response.json({ error: { code: failure.code } }, {
                status: failure.status,
                headers: { ...headers, ...(failure.status === 429 ? { 'Retry-After': '60' } : {}) },
            });
        }
    };
}
