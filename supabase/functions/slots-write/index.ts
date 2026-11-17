import { createSlotsWriteHandler } from './handler.ts';
import { createSupabaseSlotsWriteRepository } from './repository.ts';

Deno.serve(createSlotsWriteHandler({
    env: Deno.env.get,
    createRepository: createSupabaseSlotsWriteRepository,
}));
