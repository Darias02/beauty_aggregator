import { deepEqual, equal, match } from 'node:assert/strict';
import { createAvatarHandler, MAX_FILE_BYTES } from '../handler.ts';
import type { AvatarRepository } from '../handler.ts';
import { actor, botToken, now, signInitData } from '../../user-profile/tests/helpers.ts';

function harness(config: Record<string, string | undefined> = {}) {
    const old = 'https://avatar.test/old.jpg';
    const rows = new Map([actor.id, 777].map((id) => [id, {
        master_id: id,
        name: 'Имя',
        address: null,
        avatar_url: old as string | null,
    }]));
    const objects = new Map<string, string>();
    const calls: string[] = [];
    let failAt = '';
    const repository: AvatarRepository = {
        get(id) {
            calls.push(`get:${id}`);
            if (failAt === 'get') throw new Error('secret DB details');
            if (failAt === 'foreign') return Promise.resolve(rows.get(777)!);
            return Promise.resolve(rows.get(id) ? { ...rows.get(id)! } : null);
        },
        upload(path) {
            calls.push(`upload:${path}`);
            if (failAt === 'storage') throw new Error('secret Storage details');
            const url = `https://avatar.test/${path}`;
            objects.set(path, url);
            return Promise.resolve(url);
        },
        replace(id, previous, next) {
            calls.push(`replace:${id}`);
            if (failAt === 'db') return Promise.resolve({ outcome: 'rejected' });
            if (failAt === 'unknown') return Promise.resolve({ outcome: 'unknown' });
            const row = rows.get(id)!;
            if (failAt === 'committed-unknown') {
                row.avatar_url = next;
                return Promise.resolve({ outcome: 'unknown' });
            }
            if (row.avatar_url !== previous) return Promise.resolve({ outcome: 'rejected' });
            row.avatar_url = next;
            return Promise.resolve({ outcome: 'updated', profile: { ...row } });
        },
        remove(path) {
            calls.push(`remove:${path}`);
            if (failAt === 'cleanup') throw new Error('secret cleanup details');
            objects.delete(path);
            return Promise.resolve();
        },
    };
    const handler = createAvatarHandler({
        env: (name) =>
            ({
                BOT_TOKEN: botToken,
                SUPABASE_URL: 'https://avatar.test',
                SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
                ...config,
            })[name],
        nowSeconds: () => now,
        createRepository: (_url, key) => {
            equal(key, 'server-only-test-key');
            return repository;
        },
        decodeImage: (bytes, _mime) => {
            calls.push('decode');
            if (failAt === 'decode') throw new Error('Invalid bytes');
            return Promise.resolve({ bytes, mime: 'image/png', extension: 'png' });
        },
    });
    return {
        old,
        rows,
        objects,
        calls,
        repository,
        handler,
        set fail(value: string) {
            failAt = value;
        },
    };
}

function request({ init = signInitData(), fields = {}, size = 1, mime = 'image/png' } = {}) {
    const form = new FormData();
    form.append('init_data', init);
    form.append('avatar', new File([new Uint8Array(size)], '../../777/avatar.png', { type: mime }));
    for (const [key, value] of Object.entries(fields)) form.append(key, value as string);
    return new Request('https://avatar.test/functions/v1/master-avatar', {
        method: 'POST',
        body: form,
    });
}

Deno.test('Upload derives own identity/path, returns only profile and leaves other/old avatars intact', async () => {
    const h = harness();
    const foreign = { ...h.rows.get(777)! };
    const response = await h.handler(request());
    equal(response.status, 200);
    const result = await response.json();
    equal(result.profile.master_id, actor.id);
    equal(result.profile.avatar_url, h.rows.get(actor.id)!.avatar_url);
    match([...h.objects.keys()][0], /^424242\/[a-f0-9-]{36}\.png$/);
    deepEqual(h.rows.get(777), foreign);
    equal(h.calls.some((call) => call.startsWith('remove:')), false);
    equal(JSON.stringify(result).includes('server-only-test-key'), false);
    equal(response.headers.get('cache-control'), 'no-store');
});

for (
    const fields of [{ master_id: '777' }, { user: '777' }, { path: '777/a.png' }, {
        avatar_url: 'evil',
    }, { profile: '{}' }]
) {
    Deno.test(`Rejects client ownership/paths ${JSON.stringify(fields)}`, async () => {
        const h = harness();
        equal((await h.handler(request({ fields }))).status, 400);
        deepEqual(h.calls, []);
    });
}

Deno.test('Tampered and expired Telegram identity never access privileged operations', async () => {
    for (
        const init of [
            '',
            signInitData({}, 'attacker-token'),
            signInitData({ auth_date: String(now - 86401) }),
            signInitData().replace('anna_test', 'attacker'),
        ]
    ) {
        const h = harness();
        equal((await h.handler(request({ init }))).status, 401);
        deepEqual(h.calls, []);
    }
});

Deno.test('Rejects extra/duplicate form fields and URL selectors', async () => {
    const h = harness();
    equal((await h.handler(request({ fields: { init_data: signInitData() } }))).status, 400);
    const req = request();
    equal((await h.handler(new Request(req.url + '?master_id=777', req))).status, 400);
    deepEqual(h.calls, []);
});

Deno.test('Oversized file and streamed body are bounded before decoding', async () => {
    const h = harness();
    equal((await h.handler(request({ size: MAX_FILE_BYTES + 1 }))).status, 413);
    equal((await h.handler(request({ size: MAX_FILE_BYTES + 20000 }))).status, 413);
    deepEqual(h.calls, []);
});

async function withinDeadline(response: Promise<Response>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            response,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Upload handler timed out')), 2000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

Deno.test('Chunked multipart without Content-Length stops at request limit and cancels source', async () => {
    const h = harness();
    const limit = MAX_FILE_BYTES + 16384;
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            // Deliberately never close: rejecting an oversized upload must not wait for EOF.
            const chunk = new Uint8Array(65536);
            sent += chunk.length;
            controller.enqueue(chunk);
        },
        cancel() {
            cancelled = true;
        },
    }, { highWaterMark: 0 });
    const req = new Request('https://avatar.test/functions/v1/master-avatar', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=bb71' },
        body,
    });
    equal(req.headers.has('content-length'), false);
    const response = await withinDeadline(h.handler(req));
    equal(response.status, 413);
    deepEqual(await response.json(), { error: { code: 'AVATAR_TOO_LARGE' } });
    equal(cancelled, true);
    equal(sent > limit && sent <= limit + 65536, true);
    deepEqual(h.calls, []);
});

Deno.test('Content-Length rejects oversized multipart before reading or accessing Storage', async () => {
    const h = harness();
    let reads = 0;
    const req = new Request('https://avatar.test/functions/v1/master-avatar', {
        method: 'POST',
        headers: {
            'content-type': 'multipart/form-data; boundary=bb71',
            'content-length': String(MAX_FILE_BYTES + 16385),
        },
        body: new ReadableStream({
            pull() {
                reads++;
            },
        }, { highWaterMark: 0 }),
    });
    equal((await withinDeadline(h.handler(req))).status, 413);
    equal(reads, 0);
    deepEqual(h.calls, []);
});

Deno.test('Finite streamed multipart without Content-Length accepts exactly 5 MiB', async () => {
    const original = request({ size: MAX_FILE_BYTES });
    const bytes = new Uint8Array(await original.arrayBuffer());
    let offset = 0;
    const req = new Request(original.url, {
        method: 'POST',
        headers: original.headers,
        body: new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset === bytes.length) return controller.close();
                const end = Math.min(offset + 32768, bytes.length);
                controller.enqueue(bytes.subarray(offset, end));
                offset = end;
            },
        }),
    });
    equal(req.headers.has('content-length'), false);
    const h = harness();
    equal((await withinDeadline(h.handler(req))).status, 200);
    equal(h.calls.filter((call) => call === 'decode').length, 1);
});

for (const mode of ['storage', 'db', 'unknown', 'get', 'foreign', 'decode']) {
    Deno.test(`${mode} failure preserves previous and foreign avatars, sanitizes errors`, async () => {
        const h = harness();
        h.fail = mode;
        const before = JSON.stringify([...h.rows]);
        const response = await h.handler(request());
        equal(response.status, mode === 'decode' ? 400 : 500);
        equal(JSON.stringify([...h.rows]), before);
        equal((await response.text()).includes('secret'), false);
        equal(h.objects.size, mode === 'unknown' ? 1 : 0);
        if (mode === 'foreign') equal(h.calls.some((c) => c.startsWith('upload:')), false);
    });
}

Deno.test('Unknown response after committed DB update never deletes the referenced new avatar', async () => {
    const h = harness();
    h.fail = 'committed-unknown';
    equal((await h.handler(request())).status, 500);
    equal([...h.objects.values()].includes(h.rows.get(actor.id)!.avatar_url!), true);
    equal(h.calls.some((call) => call.startsWith('remove:')), false);
});

Deno.test('Concurrent uploads use distinct objects and CAS; rejected new object alone is cleaned', async () => {
    const h = harness();
    const originalUpload = h.repository.upload;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
    });
    let uploads = 0;
    h.repository.upload = async (path, image) => {
        const url = await originalUpload(path, image);
        if (++uploads === 2) release();
        await barrier;
        return url;
    };
    const responses = await Promise.all([h.handler(request()), h.handler(request())]);
    deepEqual(responses.map((r) => r.status).sort(), [200, 500]);
    equal(h.objects.size, 1);
    equal([...h.objects.values()][0], h.rows.get(actor.id)!.avatar_url);
    const removed = h.calls.filter((c) => c.startsWith('remove:'));
    equal(removed.length, 1);
    equal(removed[0].includes('777'), false);
});

Deno.test('Cleanup failures leave orphan without changing the old profile or masking error', async () => {
    const h = harness();
    h.fail = 'db';
    h.repository.remove = () => {
        throw new Error('cleanup secret');
    };
    equal((await h.handler(request())).status, 500);
    equal(h.rows.get(actor.id)!.avatar_url, h.old);
    equal(h.objects.size, 1);
});

Deno.test('Missing own profile never creates/uploads an avatar', async () => {
    const h = harness();
    h.rows.delete(actor.id);
    equal((await h.handler(request())).status, 404);
    equal(h.calls.some((c) => c.startsWith('upload:')), false);
});

Deno.test('Exact 5 MiB file is within transport limit; zero bytes and unsupported MIME are rejected', async () => {
    const h = harness();
    equal((await h.handler(request({ size: MAX_FILE_BYTES }))).status, 200);
    for (
        const options of [{ size: 0 }, { mime: 'image/svg+xml' }, {
            mime: 'application/octet-stream',
        }]
    ) {
        const invalid = harness();
        equal((await invalid.handler(request(options))).status, options.size === 0 ? 400 : 415);
        deepEqual(invalid.calls, []);
    }
});

Deno.test('Missing/malformed server keys fail closed without repository access', async () => {
    for (
        const config of [
            { SUPABASE_SERVICE_ROLE_KEY: '' },
            { SUPABASE_URL: '' },
            { BOT_TOKEN: '' },
            { SUPABASE_SECRET_KEYS: '{invalid' },
        ]
    ) {
        const h = harness(config);
        equal((await h.handler(request())).status, 503);
        equal(h.calls.some((call) => call.startsWith('get:')), false);
    }
});
