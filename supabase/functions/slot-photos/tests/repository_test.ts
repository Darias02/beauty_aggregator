import assert from 'node:assert/strict';
import { createPhotoRepository } from '../repository.ts';

Deno.test('only accessible ready objects receive hour-long signed URLs; paths stay server-side', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const repo = createPhotoRepository('https://test.invalid', 'server-test-key', (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body));
        calls.push({ path, body });
        if (path.endsWith('/rpc/slot_photos_list')) {
            assert.deepEqual(body, { p_actor: 101, p_slot: 7 });
            return Promise.resolve(Response.json([
                { photo_id: 'ready-id', object_path: '201/7/ready.jpg', state: 'ready' },
                { photo_id: 'pending-id', object_path: '201/7/pending.jpg', state: 'pending' },
            ]));
        }
        assert.equal(path, '/storage/v1/object/sign/slot-photos/201/7/ready.jpg');
        assert.deepEqual(body, { expiresIn: 3600 });
        return Promise.resolve(
            Response.json({ signedURL: '/object/sign/slot-photos/201/7/ready.jpg?token=test' }),
        );
    });
    const result = await repo.list(101, 7);
    assert.equal(calls.length, 2);
    assert.deepEqual(result.pending, ['pending-id']);
    assert.equal(result.photos.length, 1);
    assert.ok(!JSON.stringify(result).includes('object_path'));
    assert.ok(result.photos[0].expires_at > Date.now() + 3590000);
});

Deno.test('denied access never signs a Storage URL', async () => {
    let calls = 0;
    const repo = createPhotoRepository('https://test.invalid', 'test-key', () => {
        calls++;
        return Promise.resolve(
            Response.json({ code: 'PT404', message: 'Not found' }, { status: 404 }),
        );
    });
    await assert.rejects(() => repo.list(999, 7));
    assert.equal(calls, 1);
});

Deno.test('upload never upserts; retries accept only an existing immutable object', async () => {
    for (const status of [409, 500]) {
        const repo = createPhotoRepository('https://test.invalid', 'test-key', (_input, init) => {
            const headers = new Headers(init?.headers);
            assert.equal(headers.get('x-upsert'), 'false');
            return Promise.resolve(
                Response.json({
                    statusCode: String(status),
                    error: status === 409 ? 'Duplicate' : 'InternalError',
                    message: 'error',
                }, { status }),
            );
        });
        if (status === 409) await repo.upload('201/7/fixed.jpg', new Uint8Array([1]));
        else await assert.rejects(() => repo.upload('201/7/fixed.jpg', new Uint8Array([1])));
    }
});
