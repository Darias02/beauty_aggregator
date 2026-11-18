import { createAddressSuggestHandler } from './handler.ts';

Deno.serve(createAddressSuggestHandler({ env: Deno.env.get }));
