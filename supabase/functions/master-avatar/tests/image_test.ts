import { equal, rejects } from 'node:assert/strict';
import { decodeAvatar } from '../image.ts';
import { fixtures } from './fixtures.ts';
function bytes(value: string) {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

Deno.test('Vendored WASM has the documented SHA-256', async () => {
    const wasm = await Deno.readFile(new URL('../vendor/magick.wasm', import.meta.url));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', wasm));
    equal(
        Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        '54629cbcf06dd10db38b4d87fa6ab241b248c09c94f2d9689506e5f994ac5f0c',
    );
});

Deno.test('Rejects animation control chunks in PNG and WebP', async () => {
    const png = bytes(fixtures.png);
    const apng = new Uint8Array(png.length + 20);
    apng.set(png.subarray(0, 33));
    new DataView(apng.buffer).setUint32(33, 8);
    apng.set(new TextEncoder().encode('acTL'), 37);
    apng.set(png.subarray(33), 53);
    await rejects(() => decodeAvatar(apng, 'image/png'), /animated PNG/);
    for (const marker of ['ANIM', 'ANMF']) {
        const webp = bytes(fixtures.webp);
        const animated = new Uint8Array(webp.length + 8);
        animated.set(webp);
        animated.set(new TextEncoder().encode(marker), webp.length);
        new DataView(animated.buffer).setUint32(4, animated.length - 8, true);
        await rejects(() => decodeAvatar(animated, 'image/webp'), /Animated WebP/);
    }
});
for (const [ext, data] of Object.entries(fixtures)) {
    Deno.test(`Fully decodes real ${ext}, rejects spoofed MIME and truncation`, async () => {
        const input = bytes(data);
        equal((await decodeAvatar(input, `image/${ext}`)).mime, `image/${ext}`);
        await rejects(() => decodeAvatar(input, ext === 'png' ? 'image/jpeg' : 'image/png'));
        await rejects(() => decodeAvatar(input.slice(0, input.length - 8), `image/${ext}`));
        const corrupt = input.slice();
        if (ext === 'png') corrupt[46] ^= 255;
        else if (ext === 'jpeg') corrupt.fill(0, 200, 500);
        else corrupt.fill(0, 25, 40);
        await rejects(() => decodeAvatar(corrupt, `image/${ext}`));
    });
}
Deno.test('Rejects SVG, HTML and arbitrary fake headers with allowed MIME', async () => {
    for (
        const input of [
            '<svg xmlns="http://www.w3.org/2000/svg"/>',
            '<html>payload</html>',
            'not an image',
        ]
    ) {
        await rejects(() => decodeAvatar(new TextEncoder().encode(input), 'image/png'));
    }
    for (const [ext, data] of Object.entries(fixtures)) {
        const input = bytes(data);
        const fake = input.slice();
        fake.fill(0, ext === 'jpeg' ? 3 : ext === 'png' ? 8 : 12, fake.length - 2);
        await rejects(() => decodeAvatar(fake, `image/${ext}`));
    }
});

const pixelLimit =
    'iVBORw0KGgoAAAANSUhEUgAAEAAAAAgAAQAAAACO6csTAAAEEUlEQVR4nO3BMQEAAADCoPVPbQZ/oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+AwjwAAHF92sRAAAAAElFTkSuQmCC';

const sideLimit =
    'iVBORw0KGgoAAAANSUhEUgAAIAEAAAABAQAAAACx8nbzAAAAEUlEQVR4nGNgGAWjYBSMXAAABAIAARSFVjUAAAAASUVORK5CYII=';

Deno.test('Bounds file bytes and decoded pixels before allocation', async () => {
    await rejects(() => decodeAvatar(new Uint8Array(5 * 1024 * 1024 + 1), 'image/png'), /size/);
    await rejects(() => decodeAvatar(bytes(pixelLimit), 'image/png'), /dimensions/);
    await rejects(() => decodeAvatar(bytes(sideLimit), 'image/png'));
});
