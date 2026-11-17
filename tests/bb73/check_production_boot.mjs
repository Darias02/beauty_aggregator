// Runs the emitted loader with a fake DOM/fetch. No browser or network access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const bootPath = Deno.args[0];
const boot = await readFile(bootPath, 'utf8');
const gateSource = await readFile(new URL('./release-gate.js', pathToFileURL(bootPath)), 'utf8');
const { createReleaseGate } = await import('data:text/javascript,' + encodeURIComponent(gateSource));
const release = /release: "([a-f0-9]+)"/.exec(boot)[1];
// Only the terminal import is replaced by a marker; execute the actual boot logic.
const executable = boot.replace(/^import .*;\n/, '')
    .replace("await import('./app.js');", 'globalThis.appLoaded = true;');
const run = new Function('createReleaseGate', 'globalThis', 'document',
    'return (async () => {' + executable + '})();');

for (const scenario of ['current', 'outsideTelegram', 'maintenance', 'stale', 'offline']) {
    const messages = [];
    const events = {};
    let calls = 0;
    const state = { release: scenario === 'stale' ? 'new-release' : release,
        maintenance: scenario === 'maintenance' };
    const fakeWindow = {
        Telegram: { WebApp: { initData: scenario === 'outsideTelegram' ? '' : 'fake-signed-data' } },
        fetch: async url => {
            calls++;
            assert.equal(url, '/release.json');
            if (scenario === 'offline') throw new Error('offline');
            return Response.json(state);
        },
        addEventListener(name, fn) { events[name] = fn; },
    };
    const fakeDocument = {
        visibilityState: 'visible',
        createElement() { return { textContent: '', setAttribute() {} }; },
        body: { replaceChildren(node) { messages.push(node.textContent); } },
        addEventListener(name, fn) { events[name] = fn; },
    };
    await run(createReleaseGate, fakeWindow, fakeDocument);
    assert.equal(Boolean(fakeWindow.appLoaded), scenario === 'current', scenario);
    assert.equal(calls, 1);
    if (scenario !== 'current') assert.ok(messages.length > 0);
    if (scenario === 'current') {
        state.maintenance = true;
        await events.focus();
        assert.ok(messages.some(message => message.includes('Mini App')));
        await assert.rejects(() => fakeWindow.fetch('https://bxzwfidujuejmrbqjmgo.supabase.co/functions/v1/slots-write'),
            /APP_UPDATE_REQUIRED/);
        assert.equal(calls, 2);
    }
}
console.log('PASS emitted production boot: current, Telegram required, maintenance, stale, offline, resume');
