import { APP_CONFIG } from '../config.js';
import { getTelegramInitData } from '../telegram.js';
const messages = {
    UNAUTHORIZED: 'Откройте приложение заново через Telegram.',
    PHOTO_TOO_LARGE: 'Фото слишком большое. Выберите изображение меньшего размера.',
    INVALID_IMAGE:
        'Не удалось прочитать фото. Выберите JPEG, PNG или WebP. Для HEIC на iPhone экспортируйте фото в JPEG.',
    PHOTO_LIMIT: 'К слоту можно прикрепить не более 3 фотографий.',
    PHOTO_NOT_FOUND: 'Слот или фотография недоступны.',
};
export function createPhotoClient(
    { url, key, getInitData, fetchImpl = globalThis.fetch },
) {
    return async (action, slotId, photoId, file) => {
        const init = getInitData();
        if (!init) throw new Error(messages.UNAUTHORIZED);
        const body = new FormData();
        body.append('action', action);
        body.append('slot_id', String(slotId));
        body.append('init_data', init);
        if (photoId) body.append('photo_id', photoId);
        if (file) body.append('photo', file, 'photo.jpg');
        const response = await fetchImpl(`${url}/functions/v1/slot-photos`, {
            method: 'POST',
            headers: { apikey: key },
            body,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
        });
        const result = await response.json();
        if (!response.ok) {
            const error = new Error(
                messages[result?.error?.code] ||
                    'Не удалось загрузить фотографии. Попробуйте ещё раз.',
            );
            error.code = result?.error?.code;
            throw error;
        }
        if (action === 'list') {
            if (
                !Array.isArray(result?.photos) || result.photos.length > 3 ||
                !result.photos.every((photo) => {
                    if (
                        typeof photo?.photo_id !== 'string' ||
                        !Number.isFinite(photo.expires_at) || typeof photo.url !== 'string'
                    ) {
                        return false;
                    }
                    try {
                        const parsed = new URL(photo.url);
                        return parsed.protocol === 'https:' ||
                            (parsed.origin === new URL(url).origin &&
                                ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
                    } catch {
                        return false;
                    }
                })
            ) throw new Error('Не удалось прочитать фотографии. Попробуйте ещё раз.');
        } else if (
            action === 'upload' ? result?.uploaded !== true : result?.deleted !== true
        ) {
            throw new Error(
                'Не удалось подтвердить сохранение фото. Повторите попытку.',
            );
        }
        return result;
    };
}
export const photoRequest = createPhotoClient({
    ...APP_CONFIG.supabase,
    getInitData: getTelegramInitData,
});

export async function preparePhoto(file) {
    if (!file.size || file.size > 25 * 1024 * 1024) {
        throw new Error('Выберите фото размером до 25 МБ.');
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new Error(messages.INVALID_IMAGE);
    }
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        try {
            await image.decode();
        } catch {
            throw new Error(messages.INVALID_IMAGE);
        }
        if (
            !image.naturalWidth || !image.naturalHeight ||
            image.naturalWidth * image.naturalHeight > 60000000
        ) {
            throw new Error(
                'Слишком большое разрешение фото. Уменьшите изображение.',
            );
        }
        // Browser decoding applies EXIF orientation, including iPhone JPEGs.
        const scale = Math.min(
            1,
            1600 / Math.max(image.naturalWidth, image.naturalHeight),
        );
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Не удалось обработать фото.');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        let blob;
        for (const quality of [0.82, 0.7, 0.5]) {
            blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (blob && blob.size <= 700 * 1024) break;
        }
        if (!blob || blob.size > 700 * 1024) {
            throw new Error(messages.PHOTO_TOO_LARGE);
        }
        return blob;
    } finally {
        URL.revokeObjectURL(url);
    }
}
