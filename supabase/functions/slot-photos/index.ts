import { createPhotoHandler } from './handler.ts';
import { createPhotoRepository } from './repository.ts';
import { normalizePhoto } from './image.ts';
Deno.serve(
    createPhotoHandler({
        env: Deno.env.get,
        createRepository: createPhotoRepository,
        normalize: normalizePhoto,
    }),
);
