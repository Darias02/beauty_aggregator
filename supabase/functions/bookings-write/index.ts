import { createBookingsWriteHandler } from './handler.ts';
import { createSupabaseBookingsWriteRepository } from './repository.ts';

Deno.serve(createBookingsWriteHandler({
    env: Deno.env.get,
    createRepository: createSupabaseBookingsWriteRepository,
}));
