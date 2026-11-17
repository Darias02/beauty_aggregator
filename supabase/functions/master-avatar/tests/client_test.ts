import { deepEqual, equal, rejects } from 'node:assert/strict';
import {
    createMasterProfileClient,
    MasterProfileApiError,
} from '../../../../webapp/js/data/masters.js';

Deno.test('Avatar client sends signed initData and file only to server; no privileged requests or identity', async () => {
    let count = 0;
    const client = createMasterProfileClient({
        url: 'https://avatar.test',
        key: 'publishable-test-key',
        getInitData: () => 'signed',
        fetchImpl: async (input, init) => {
            count++;
            const req = new Request(input, init);
            equal(req.url, 'https://avatar.test/functions/v1/master-avatar');
            equal(req.method, 'POST');
            equal(req.headers.get('apikey'), 'publishable-test-key');
            equal(req.headers.has('authorization'), false);
            equal(init?.cache, 'no-store');
            equal(init?.credentials, 'omit');
            equal(init?.redirect, 'error');
            const form = await req.formData();
            deepEqual([...form.keys()].sort(), ['avatar', 'init_data']);
            equal(form.get('init_data'), 'signed');
            equal((form.get('avatar') as File).size, 3);
            return Response.json({
                profile: {
                    master_id: 424242,
                    name: 'Имя',
                    address: null,
                    avatar_url: 'https://avatar.test/new.png',
                },
            });
        },
    });
    equal(
        (await client.uploadOwnAvatar(new File(['png'], 'photo.png', { type: 'image/png' })))
            .master_id,
        424242,
    );
    equal(count, 1);
});

Deno.test('Avatar client fails closed on missing auth, network, invalid response and server error', async () => {
    for (const mode of ['auth', 'network', 'response', 'error']) {
        let count = 0;
        const client = createMasterProfileClient({
            url: 'https://avatar.test',
            key: 'public',
            getInitData: () => mode === 'auth' ? '' : 'signed',
            fetchImpl: () => {
                count++;
                if (mode === 'network') throw new Error('secret');
                return Promise.resolve(
                    mode === 'response' ? Response.json({ profile: null }) : Response.json({
                        error: { code: 'AVATAR_UNAVAILABLE', message: 'secret' },
                    }, { status: 500 }),
                );
            },
        });
        await rejects(
            () => client.uploadOwnAvatar(new File(['x'], 'a.png', { type: 'image/png' })),
            (error: unknown) => {
                equal(error instanceof MasterProfileApiError, true);
                equal((error as Error).message.includes('secret'), false);
                return true;
            },
        );
        equal(count, mode === 'auth' ? 0 : 1);
    }
});
