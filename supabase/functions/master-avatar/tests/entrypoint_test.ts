import { equal } from 'node:assert/strict';

Deno.test('Real entrypoint initializes WASM and registers a working HTTP handler', async () => {
    const serve = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
    let handler: ((req: Request) => Promise<Response>) | undefined;
    try {
        Object.defineProperty(Deno, 'serve', {
            configurable: true,
            value: (registered: typeof handler) => {
                handler = registered;
            },
        });
        await import('../index.ts');
        equal(typeof handler, 'function');
        const response = await handler!(new Request('https://avatar.test', { method: 'OPTIONS' }));
        equal(response.status, 200);
        equal(await response.text(), 'ok');
    } finally {
        Object.defineProperty(Deno, 'serve', serve);
    }
});
