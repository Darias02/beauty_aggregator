import { deepEqual, equal, match, rejects, throws } from 'node:assert/strict';
import { createAvatarRepository } from '../repository.ts';

function harness(status = 200, transportFailure = false) {
    const calls: Request[] = [];
    const repo = createAvatarRepository(
        'https://avatar.test',
        'server-only-test-key',
        async (input, init) => {
            const req = new Request(input, init);
            calls.push(req.clone());
            equal(req.headers.get('apikey'), 'server-only-test-key');
            equal(req.headers.get('authorization'), 'Bearer server-only-test-key');
            if (transportFailure) throw new Error('Lost response');
            if (status >= 400) {
                return Response.json({ code: '42501', message: 'secret' }, {
                    status,
                });
            }
            if (req.method === 'PATCH') {
                const body = await req.json();
                return Response.json([{
                    master_id: 424242,
                    name: 'Имя',
                    address: null,
                    avatar_url: body.avatar_url,
                }]);
            }
            return Response.json({ Key: 'test', data: [] });
        },
    );
    return { repo, calls };
}

Deno.test('Public avatar origin changes only returned URL; privileged requests keep internal origin', async () => {
    const calls: string[] = [];
    const repo = createAvatarRepository('http://kong:8000', 'local-only-server-key', (input) => {
        calls.push(String(input));
        return Promise.resolve(Response.json({ Key: 'test' }));
    }, 'http://127.0.0.1:57321');
    const url = await repo.upload('201/local.png', {
        bytes: new Uint8Array([1]), mime: 'image/png', extension: 'png',
    });
    equal(url, 'http://127.0.0.1:57321/storage/v1/object/public/master-avatars/201/local.png');
    deepEqual(calls, ['http://kong:8000/storage/v1/object/master-avatars/201/local.png']);
});

Deno.test('Avatar public origin rejects paths, credentials, unsafe protocols and non-local HTTP', () => {
    for (const origin of ['https://example.test/path', 'https://user:pass@example.test',
        'javascript:alert(1)', 'http://example.test', 'https://example.test?key=x']) {
        throws(() => createAvatarRepository('http://kong:8000', 'local-only-server-key', fetch, origin));
    }
});

Deno.test('SDK uploads only server object with exact MIME and no overwrite; cleanup deletes exact path', async () => {
    const h = harness();
    const path = '424242/unique.png';
    const url = await h.repo.upload(path, {
        bytes: new Uint8Array([1, 2]),
        mime: 'image/png',
        extension: 'png',
    });
    equal(url, `https://avatar.test/storage/v1/object/public/master-avatars/${path}`);
    equal(h.calls[0].method, 'POST');
    equal(new URL(h.calls[0].url).pathname, `/storage/v1/object/master-avatars/${path}`);
    equal(h.calls[0].headers.get('x-upsert'), 'false');
    equal(h.calls[0].headers.get('content-type'), 'image/png');
    deepEqual(new Uint8Array(await h.calls[0].arrayBuffer()), new Uint8Array([1, 2]));
    await h.repo.remove(path);
    equal(h.calls[1].method, 'DELETE');
    deepEqual(await h.calls[1].json(), { prefixes: [path] });
});

for (const previous of [null, 'https://avatar.test/old.jpg']) {
    Deno.test(`SDK update filters verified master and expected previous avatar ${previous}`, async () => {
        const h = harness();
        const result = await h.repo.replace(424242, previous, 'https://avatar.test/new.png');
        equal(result.outcome, 'updated');
        const url = new URL(h.calls[0].url);
        equal(url.pathname, '/rest/v1/masters');
        equal(url.searchParams.get('master_id'), 'eq.424242');
        equal(url.searchParams.get('avatar_url'), previous === null ? 'is.null' : `eq.${previous}`);
        equal(url.searchParams.get('select'), 'master_id,name,address,avatar_url');
        deepEqual(await h.calls[0].json(), { avatar_url: 'https://avatar.test/new.png' });
    });
}

Deno.test('SDK distinguishes definitive DB rejection from ambiguous server/transport failure', async () => {
    for (const status of [400, 403, 409, 500, 502]) {
        const h = harness(status);
        equal(
            (await h.repo.replace(424242, null, 'next')).outcome,
            status < 500 ? 'rejected' : 'unknown',
        );
        equal(h.calls.length, 1);
        match(h.calls[0].url, /master_id=eq.424242/);
    }
    const h = harness(200, true);
    equal((await h.repo.replace(424242, null, 'next')).outcome, 'unknown');
    await rejects(() =>
        h.repo.upload('424242/new.png', {
            bytes: new Uint8Array([1]),
            mime: 'image/png',
            extension: 'png',
        })
    );
});
