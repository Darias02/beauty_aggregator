// Loopback-only development entrypoint. Does not read shell env or contact Supabase.
import { createAddressSuggestHandler } from '../supabase/functions/address-suggest/handler.ts';

const path = Deno.args[0];
if (!path) throw new Error('Private env file path required');
const settings = new Map<string, string>();
for (const line of (await Deno.readTextFile(path)).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Invalid local settings');
    settings.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
}
if (!settings.get('BOT_TOKEN')?.startsWith('000000000:')) {
    throw new Error('Only synthetic local credentials are supported');
}
const handler = createAddressSuggestHandler({ env: name => settings.get(name) });
Deno.serve({ hostname: '127.0.0.1', port: 8077, onListen: () => {} }, handler);
