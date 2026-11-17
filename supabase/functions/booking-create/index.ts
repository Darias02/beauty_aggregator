import { createBookingHandler } from './handler.ts';
import { createSupabaseBookingRepository } from './repository.ts';

Deno.serve(createBookingHandler({
    env: Deno.env.get,
    createRepository: createSupabaseBookingRepository,
}));
