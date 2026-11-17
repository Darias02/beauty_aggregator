import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../webapp/js/release-gate.js', import.meta.url), 'utf8');
const { createReleaseGate } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const projectUrl = 'https://example.test';
const api = projectUrl + '/functions/v1/slots-write';

function fixture(state = { release: 'current', maintenance: false }) {
    const calls = [];
    const blocks = [];
    const gate = createReleaseGate({ release: 'current', projectUrl, block: m => blocks.push(m),
        fetchImpl: async (url, options) => {
            calls.push([url, options]);
            if (url === '/release.json') return state instanceof Error ? Promise.reject(state) : Response.json(state);
            return Response.json({ deleted: true });
        } });
    return { ...gate, calls, blocks };
}

test('current release passes a fresh no-store check before forwarding signed API request unchanged', async () => {
    const f = fixture();
    const options = { method: 'POST', body: 'fake signed init_data' };
    assert.deepEqual(await (await f.fetch(api, options)).json(), { deleted: true });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0][0], '/release.json');
    const { signal, ...optionsBeforeApi } = f.calls[0][1];
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(optionsBeforeApi, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    assert.equal(f.calls[1][1], options);
    assert.equal(f.blocks.length, 0);
});

test('old open clients, maintenance, malformed state and offline failures never send API data', async () => {
    for (const state of [{ release: 'next', maintenance: false }, { release: 'current', maintenance: true },
        {}, null, new Error('offline')]) {
        const f = fixture(state);
        await assert.rejects(() => f.fetch(api, { body: 'fake secret init_data' }), /APP_UPDATE_REQUIRED/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.blocks.length, 1);
        await assert.rejects(() => f.fetch(api), /APP_UPDATE_REQUIRED/);
        assert.equal(f.calls.length, 1);
    }
});

test('each API call rechecks policy; an open client stops when the release changes', async () => {
    let current = true;
    let sent = 0;
    const gate = createReleaseGate({ release: 'current', projectUrl, block() {},
        fetchImpl: async url => url === '/release.json'
            ? Response.json({ release: current ? 'current' : 'next', maintenance: false })
            : (sent++, Response.json({})) });
    await gate.fetch(api);
    current = false;
    await assert.rejects(() => gate.fetch(api), /APP_UPDATE_REQUIRED/);
    assert.equal(sent, 1);
});

test('foreign origins and non-function assets are not rewritten or sent to project API', async () => {
    const f = fixture();
    await f.fetch('https://cdn.example.test/functions/v1/asset');
    await f.fetch(projectUrl + '/storage/v1/object/public/avatar');
    assert.equal(f.calls.length, 2);
    assert.equal(f.blocks.length, 0);
});
