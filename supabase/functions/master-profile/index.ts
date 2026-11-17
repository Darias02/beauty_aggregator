import { createProfileHandler } from './handler.ts';
import { createSupabaseProfileRepository } from './repository.ts';

Deno.serve(createProfileHandler({
    env: Deno.env.get,
    createRepository: createSupabaseProfileRepository,
}));
