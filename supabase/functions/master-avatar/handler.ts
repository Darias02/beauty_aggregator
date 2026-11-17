import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';
import type { Profile } from '../master-profile/handler.ts';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 16384;
const headers = { ...corsHeaders, 'Cache-Control': 'no-store' };

export interface AvatarImage {
    bytes: Uint8Array;
    mime: 'image/jpeg' | 'image/png' | 'image/webp';
    extension: 'jpg' | 'png' | 'webp';
}

export interface AvatarRepository {
    get(id: number): Promise<Profile | null>;
    upload(path: string, image: AvatarImage): Promise<string>;
    // "rejected" means the database definitively rejected/rolled back the write.
    // A lost response is "unknown": deleting then could break a committed avatar.
    replace(id: number, previous: string | null, next: string): Promise<
        { outcome: 'updated'; profile: Profile } | { outcome: 'rejected' | 'unknown' }
    >;
    remove(path: string): Promise<void>;
}

interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: (url: string, key: string) => AvatarRepository;
    decodeImage: (bytes: Uint8Array, mime: string) => Promise<AvatarImage>;
    nowSeconds?: () => number;
}

class RequestError extends Error {
    constructor(readonly status: number, readonly code: string) {
        super(code);
    }
}

function fail(status: number, code: string): never {
    throw new RequestError(status, code);
}

async function readForm(req: Request): Promise<FormData> {
    const type = req.headers.get('content-type') || '';
    if (!/^multipart\/form-data\s*;/i.test(type)) fail(415, 'INVALID_IMAGE');
    const length = req.headers.get('content-length');
    if (length && Number(length) > MAX_REQUEST_BYTES) fail(413, 'AVATAR_TOO_LARGE');
    const reader = req.body?.getReader();
    if (!reader) fail(400, 'INVALID_REQUEST');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_REQUEST_BYTES) {
                await reader.cancel();
                fail(413, 'AVATAR_TOO_LARGE');
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
        return await new Response(bytes, { headers: { 'content-type': type } }).formData();
    } catch {
        fail(400, 'INVALID_REQUEST');
    }
}

function ownProfile(profile: Profile | null, id: number): profile is Profile {
    return profile !== null && profile.master_id === id && typeof profile.name === 'string' &&
        (profile.address === null || typeof profile.address === 'string') &&
        (profile.avatar_url === null || typeof profile.avatar_url === 'string');
}

export function createAvatarHandler(dependencies: Dependencies) {
    return async (req: Request): Promise<Response> => {
        if (req.method === 'OPTIONS') return new Response('ok', { headers });
        try {
            if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
            if (new URL(req.url).search) fail(400, 'INVALID_REQUEST');
            const form = await readForm(req);
            const initData = form.get('init_data');
            const token = dependencies.env('BOT_TOKEN');
            if (!token) fail(503, 'SERVER_NOT_CONFIGURED');
            const actor = await validateInitData(initData, token, {
                nowSeconds: dependencies.nowSeconds?.(),
            });
            if (!actor) fail(401, 'UNAUTHORIZED');
            if (
                [...form.keys()].some((key) => !['init_data', 'avatar'].includes(key)) ||
                form.getAll('init_data').length !== 1 || form.getAll('avatar').length !== 1
            ) fail(400, 'INVALID_REQUEST');
            const file = form.get('avatar');
            if (!(file instanceof File) || file.size === 0) fail(400, 'INVALID_IMAGE');
            if (file.size > MAX_FILE_BYTES) fail(413, 'AVATAR_TOO_LARGE');
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                fail(415, 'INVALID_IMAGE');
            }
            let image: AvatarImage;
            try {
                image = await dependencies.decodeImage(
                    new Uint8Array(await file.arrayBuffer()),
                    file.type,
                );
            } catch {
                fail(400, 'INVALID_IMAGE');
            }
            let key: string;
            try {
                key = getAdminKey(dependencies.env);
            } catch {
                fail(503, 'SERVER_NOT_CONFIGURED');
            }
            const url = dependencies.env('SUPABASE_URL');
            if (!url || !key.trim()) fail(503, 'SERVER_NOT_CONFIGURED');
            const repository = dependencies.createRepository(url, key);
            const previous = await repository.get(actor.id);
            if (!previous) fail(404, 'PROFILE_NOT_FOUND');
            if (!ownProfile(previous, actor.id)) throw new Error('Invalid profile');

            // Never use a client filename, path, ID or upsert; old avatars remain intact.
            const path = `${actor.id}/${crypto.randomUUID()}.${image.extension}`;
            const avatarUrl = await repository.upload(path, image);
            const result = await repository.replace(actor.id, previous.avatar_url, avatarUrl);
            if (result.outcome !== 'updated') {
                if (result.outcome === 'rejected') {
                    try {
                        const current = await repository.get(actor.id);
                        if (
                            current === null ||
                            (ownProfile(current, actor.id) && current.avatar_url !== avatarUrl)
                        ) {
                            await repository.remove(path);
                        }
                    } catch {
                        // Fail closed: retain an orphan if its use or deletion is uncertain.
                        console.warn('Avatar cleanup deferred');
                    }
                } else {
                    console.warn('Avatar write outcome unknown; cleanup deferred');
                }
                fail(500, 'AVATAR_UNAVAILABLE');
            }
            if (!ownProfile(result.profile, actor.id) || result.profile.avatar_url !== avatarUrl) {
                throw new Error('Invalid avatar update result');
            }
            const { master_id, name, address, avatar_url } = result.profile;
            return Response.json({ profile: { master_id, name, address, avatar_url } }, {
                headers,
            });
        } catch (error) {
            const status = error instanceof RequestError ? error.status : 500;
            const code = error instanceof RequestError ? error.code : 'AVATAR_UNAVAILABLE';
            return Response.json({ error: { code } }, { status, headers });
        }
    };
}
