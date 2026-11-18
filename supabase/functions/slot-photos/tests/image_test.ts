import { normalizePhoto } from '../image.ts';
import { fixtureBytes } from '../../master-avatar/tests/fixtures.ts';
for (
    const [ext, mime] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], [
        'webp',
        'image/webp',
    ]] as const
) {
    Deno.test(`normalizes ${ext} into a stripped JPEG`, async () => {
        const bytes = await normalizePhoto(fixtureBytes(ext), mime);
        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.length > 2097152) {
            throw new Error('Invalid normalized JPEG');
        }
        const text = new TextDecoder().decode(bytes);
        if (text.includes('Exif') || text.includes('GPS')) {
            throw new Error('Metadata leaked');
        }
    });
}
Deno.test('rejects HEIC, corrupt bytes and forged MIME', async () => {
    for (
        const [bytes, mime] of [[new Uint8Array([1, 2, 3]), 'image/heic'], [
            fixtureBytes('png'),
            'image/jpeg',
        ], [fixtureBytes('jpeg').slice(0, 30), 'image/jpeg']] as const
    ) {
        let failed = false;
        try {
            await normalizePhoto(bytes, mime);
        } catch {
            failed = true;
        }
        if (!failed) throw new Error('Unsafe input accepted');
    }
});

Deno.test('iPhone-style JPEG rotates pixels before removing personal EXIF metadata', async () => {
    const { orientedJpeg } = await import('./iphone_fixture.ts');
    const { ImageMagick } = await import('@imagemagick/magick-wasm');
    const bytes = await normalizePhoto(
        Uint8Array.from(atob(orientedJpeg), (c) => c.charCodeAt(0)),
        'image/jpeg',
    );
    ImageMagick.read(bytes, (image) => {
        if (image.width !== 3 || image.height !== 4) {
            throw new Error('EXIF orientation lost');
        }
    });
    const text = new TextDecoder().decode(bytes);
    if (text.includes('PRIVATE') || text.includes('Exif')) {
        throw new Error('Personal metadata leaked');
    }
});
