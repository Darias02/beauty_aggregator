// deno-lint-ignore-file require-await
import assert from 'node:assert/strict';
import { createPhotoHandler } from '../handler.ts';
import { botToken, signInitData } from '../../user-profile/tests/helpers.ts';
const id = '152931fc-d80b-45c9-a371-fb21e7e02311';
function fixture(
    { rejected = false, uploadFails = false, finishFails = false } = {},
) {
    const calls: string[] = [];
    const handler = createPhotoHandler({
        env: (key) =>
            ({
                BOT_TOKEN: botToken,
                SUPABASE_URL: 'https://example.test',
                SUPABASE_SERVICE_ROLE_KEY: 'test-only',
            })[key],
        normalize: async () => new Uint8Array([255, 216, 255, 217]),
        createRepository: () => ({
            write: async (actor, slot, photo, action) => {
                calls.push(`${actor}:${slot}:${action}`);
                if (rejected) throw { code: 'PT404' };
                if (finishFails && action === 'finish') {
                    throw new Error('lost response');
                }
                return {
                    photo_id: photo,
                    object_path: 'server/path.jpg',
                    state: 'pending',
                };
            },
            list: async (actor, slot) => {
                calls.push(`${actor}:${slot}:list`);
                return { photos: [], pending: [] };
            },
            upload: async () => {
                calls.push('upload');
                if (uploadFails) throw new Error('network');
            },
            remove: async () => {
                calls.push('remove');
            },
        }),
    });
    const request = (
        action: string,
        init = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) }),
        extra?: [string, string],
    ) => {
        const form = new FormData();
        form.append('action', action);
        form.append('init_data', init);
        form.append('slot_id', '7');
        form.append('photo_id', id);
        if (action === 'upload') {
            form.append(
                'photo',
                new Blob(['test'], { type: 'image/jpeg' }),
                '../../other.jpg',
            );
        }
        if (extra) form.append(...extra);
        return handler(
            new Request('https://example.test', { method: 'POST', body: form }),
        );
    };
    return { calls, request };
}
Deno.test('rejects invalid authorization and injected identity before repository access', async () => {
    const f = fixture();
    assert.equal((await f.request('upload', 'forged')).status, 401);
    assert.equal(
        (await f.request('upload', undefined, ['master_id', '123'])).status,
        400,
    );
    assert.deepEqual(f.calls, []);
});
Deno.test('checks owned reservation before upload; filenames never select object paths', async () => {
    const f = fixture({ rejected: true });
    assert.equal((await f.request('upload')).status, 404);
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].endsWith(':7:reserve'));
});
Deno.test('upload failure and uncertain finalization never delete files or slot', async () => {
    for (const options of [{ uploadFails: true }, { finishFails: true }]) {
        const f = fixture(options);
        assert.equal((await f.request('upload')).status, 500);
        assert.ok(!f.calls.includes('remove'));
    }
});
Deno.test('upload finalizes only after storage success; deletion uses owned metadata', async () => {
    const f = fixture();
    assert.equal((await f.request('upload')).status, 200);
    assert.deepEqual(f.calls.map((c) => c.split(':').at(-1)), [
        'reserve',
        'upload',
        'finish',
    ]);
    assert.equal((await f.request('delete')).status, 200);
    assert.deepEqual(f.calls.slice(-2).map((c) => c.split(':').at(-1)), [
        'delete',
        'remove',
    ]);
});
