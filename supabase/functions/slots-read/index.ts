import { createSlotsHandler } from './handler.ts';
import { createSupabaseSlotsRepository } from './repository.ts';

Deno.serve(createSlotsHandler({
    env: Deno.env.get,
    createRepository: createSupabaseSlotsRepository,
}));
