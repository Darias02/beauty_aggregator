import {
    ConfigurationFiles,
    ImageMagick,
    initializeImageMagick,
    MagickColors,
    MagickFormat,
    MagickReadSettings,
} from '@imagemagick/magick-wasm';

// This binary is bundled locally: no remote fetch or uploaded-code execution.
const ready = (async () => {
    const configuration = ConfigurationFiles.default;
    configuration.policy.data = `<policymap>
        <policy domain="resource" name="memory" value="64MiB"/>
        <policy domain="resource" name="map" value="0"/>
        <policy domain="resource" name="disk" value="0"/>
        <policy domain="resource" name="width" value="8192"/>
        <policy domain="resource" name="height" value="8192"/>
        <policy domain="resource" name="list-length" value="2"/>
        <policy domain="resource" name="thread" value="1"/>
        <policy domain="delegate" rights="none" pattern="*"/>
        <policy domain="path" rights="none" pattern="*"/>
        <policy domain="coder" rights="none" pattern="*"/>
        <policy domain="coder" rights="read" pattern="{JPEG,PNG,WEBP,XC}"/>
    </policymap>`;
    await initializeImageMagick(
        await Deno.readFile(new URL('./vendor/magick.wasm', import.meta.url)),
        configuration,
    );
})();
await ready;

function ascii(bytes: Uint8Array, start: number, size: number) {
    return String.fromCharCode(...bytes.subarray(start, start + size));
}

function detect(bytes: Uint8Array) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Incomplete JPEG');
        return { mime: 'image/jpeg', extension: 'jpg', format: MagickFormat.Jpeg } as const;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') {
        let offset = 8;
        let ended = false;
        while (offset + 12 <= bytes.length) {
            const length = view.getUint32(offset);
            const type = ascii(bytes, offset + 4, 4);
            if (offset + 12 + length > bytes.length || type === 'acTL') {
                throw new Error('Invalid/animated PNG');
            }
            offset += 12 + length;
            if (type === 'IEND') {
                if (length !== 0 || offset !== bytes.length) throw new Error('Invalid PNG end');
                ended = true;
                break;
            }
        }
        if (!ended) throw new Error('Incomplete PNG');
        return { mime: 'image/png', extension: 'png', format: MagickFormat.Png } as const;
    }
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
        if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('Incomplete WebP');
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const type = ascii(bytes, offset, 4);
            const length = view.getUint32(offset + 4, true);
            if (type === 'ANIM' || type === 'ANMF') throw new Error('Animated WebP');
            offset += 8 + length + (length % 2);
        }
        if (offset !== bytes.length) throw new Error('Invalid WebP chunks');
        return { mime: 'image/webp', extension: 'webp', format: MagickFormat.WebP } as const;
    }
    throw new Error('Unsupported image bytes');
}

export async function decodeAvatar(bytes: Uint8Array, declaredMime: string) {
    if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) throw new Error('Invalid image size');
    const detected = detect(bytes);
    if (detected.mime !== declaredMime) throw new Error('MIME mismatch');
    await ready;
    // Ping reads dimensions before allocating the decoded pixel buffer. Read then
    // decodes all pixels; signature checks and ping alone cannot validate images.
    ImageMagick.read(MagickColors.Transparent, 1, 1, (image) => {
        let warned = false;
        image.onWarning = () => {
            warned = true;
            return 0;
        };
        const settings = new MagickReadSettings({ format: detected.format });
        image.ping(bytes, settings);
        if (!image.width || !image.height || image.width * image.height > 4_000_000) {
            throw new Error('Image dimensions exceed safe decode limits');
        }
        image.read(bytes, settings);
        if (warned || image.format !== detected.format) throw new Error('Damaged image');
    });
    return { bytes, mime: detected.mime, extension: detected.extension };
}
