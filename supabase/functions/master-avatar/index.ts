import { createAvatarHandler } from './handler.ts';
import { decodeAvatar } from './image.ts';
import { createAvatarRepository } from './repository.ts';

Deno.serve(createAvatarHandler({
    env: Deno.env.get,
    createRepository: (url, key) =>
        createAvatarRepository(url, key, fetch, Deno.env.get('AVATAR_PUBLIC_ORIGIN')),
    decodeImage: decodeAvatar,
}));
