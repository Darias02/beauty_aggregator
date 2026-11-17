import { createCatalogHandler } from './handler.ts';
import { createSupabaseCatalogRepository } from './repository.ts';

Deno.serve(createCatalogHandler({
    env: Deno.env.get,
    createRepository: createSupabaseCatalogRepository,
}));
