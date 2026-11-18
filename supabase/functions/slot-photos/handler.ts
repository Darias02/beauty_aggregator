import { corsHeaders, getAdminKey, validateInitData } from '../_shared/telegram.ts';
import type { createPhotoRepository } from './repository.ts';
const headers = { ...corsHeaders, 'Cache-Control': 'no-store' };
const MAX_BYTES = 2 * 1024 * 1024 + 16384;
class PhotoError extends Error {
    constructor(readonly status: number, readonly code: string) {
        super(code);
    }
}
interface Dependencies {
    env: (name: string) => string | undefined;
    createRepository: typeof createPhotoRepository;
    normalize: (bytes: Uint8Array, mime: string) => Promise<Uint8Array>;
}
export function createPhotoHandler(deps: Dependencies) {
    return async (req: Request) => {
        if (req.method === 'OPTIONS') return new Response('ok', { headers });
        try {
            if (req.method !== 'POST') {
                throw new PhotoError(405, 'METHOD_NOT_ALLOWED');
            }
            if (new URL(req.url).search) throw new PhotoError(400, 'INVALID_REQUEST');
            const reader = req.body?.getReader();
            if (!reader) throw new PhotoError(400, 'INVALID_REQUEST');
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > MAX_BYTES) {
                        await reader.cancel();
                        throw new PhotoError(413, 'PHOTO_TOO_LARGE');
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
                offset += chunk.length;
            }
            let form: FormData;
            try {
                form = await new Response(bytes, {
                    headers: { 'content-type': req.headers.get('content-type') || '' },
                }).formData();
            } catch {
                throw new PhotoError(400, 'INVALID_REQUEST');
            }
            const token = deps.env('BOT_TOKEN');
            if (!token) throw new PhotoError(503, 'SERVER_NOT_CONFIGURED');
            const actor = await validateInitData(form.get('init_data'), token);
            if (!actor) throw new PhotoError(401, 'UNAUTHORIZED');
            const action = form.get('action');
            const allowed = action === 'upload'
                ? ['init_data', 'action', 'slot_id', 'photo_id', 'photo']
                : ['init_data', 'action', 'slot_id', 'photo_id'];
            for (const key of form.keys()) {
                if (!allowed.includes(key) || form.getAll(key).length !== 1) {
                    throw new PhotoError(400, 'INVALID_REQUEST');
                }
            }
            const slot = form.get('slot_id');
            if (
                typeof slot !== 'string' || !/^[1-9]\d*$/.test(slot) ||
                !Number.isSafeInteger(Number(slot))
            ) throw new PhotoError(400, 'INVALID_REQUEST');
            const url = deps.env('SUPABASE_URL');
            const key = getAdminKey(deps.env);
            if (!url || !key) throw new PhotoError(503, 'SERVER_NOT_CONFIGURED');
            const repo = deps.createRepository(url, key);
            if (action === 'list') {
                return Response.json(await repo.list(actor.id, Number(slot)), {
                    headers,
                });
            }
            const id = form.get('photo_id');
            if (
                typeof id !== 'string' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
                    .test(id)
            ) throw new PhotoError(400, 'INVALID_REQUEST');
            if (action === 'delete') {
                const photo = await repo.write(actor.id, Number(slot), id, 'delete');
                // Metadata hides the photo immediately; failed physical deletion is retried by cleanup.
                try {
                    await repo.remove(photo);
                } catch { /* retained deletion tombstone */ }
                return Response.json({ deleted: true }, { headers });
            }
            if (action !== 'upload') throw new PhotoError(400, 'INVALID_REQUEST');
            const file = form.get('photo');
            if (
                !(file instanceof File) || !file.size || file.size > 2 * 1024 * 1024
            ) {
                throw new PhotoError(413, 'PHOTO_TOO_LARGE');
            }
            let image: Uint8Array;
            try {
                image = await deps.normalize(
                    new Uint8Array(await file.arrayBuffer()),
                    file.type,
                );
            } catch {
                throw new PhotoError(415, 'INVALID_IMAGE');
            }
            // Reservation locks the owned slot and enforces the three-photo limit in SQL.
            const photo = await repo.write(actor.id, Number(slot), id, 'reserve');
            if (photo.state === 'ready') {
                return Response.json({ uploaded: true }, { headers });
            }
            await repo.upload(photo.object_path, image);
            // Unknown outcomes retain the object. Cleanup must never remove a ready photo.
            await repo.write(actor.id, Number(slot), id, 'finish');
            return Response.json({ uploaded: true }, { headers });
        } catch (error) {
            const dbCode = error && typeof error === 'object' && 'code' in error
                ? error.code
                : null;
            const status = error instanceof PhotoError
                ? error.status
                : dbCode === 'PT404'
                ? 404
                : dbCode === 'PT409'
                ? 409
                : 500;
            const code = error instanceof PhotoError
                ? error.code
                : dbCode === 'PT404'
                ? 'PHOTO_NOT_FOUND'
                : dbCode === 'PT409'
                ? 'PHOTO_LIMIT'
                : 'PHOTOS_UNAVAILABLE';
            return Response.json({ error: { code } }, { status, headers });
        }
    };
}
