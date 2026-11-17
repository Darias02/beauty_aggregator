import { createBookingsHandler } from './handler.ts';
import { createSupabaseBookingsRepository } from './repository.ts';

Deno.serve(createBookingsHandler({
    env: Deno.env.get,
    createRepository: createSupabaseBookingsRepository,
}));
