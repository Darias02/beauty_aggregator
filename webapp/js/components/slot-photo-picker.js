import { photoRequest, preparePhoto } from '../data/slot-photos.js';
export function createSlotPhotoPicker(host) {
    let items = [];
    let busy = false;
    let savedSlot = null;
    const title = document.createElement('div');
    title.textContent = 'Фотографии работ';
    title.className = 'photo-picker-title';
    const hint = document.createElement('p');
    hint.className = 'photo-picker-hint';
    hint.textContent =
        'До 3 фото, необязательно. JPEG, PNG, WebP до 25 МБ. Перед отправкой фото уменьшаются.';
    const grid = document.createElement('div');
    grid.className = 'photo-picker-grid';
    const status = document.createElement('p');
    status.className = 'photo-picker-status';
    status.setAttribute('role', 'status');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.multiple = true;
    input.hidden = true;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'photo-add';
    add.textContent = 'Добавить фото';
    add.onclick = () => {
        input.dataset.replace = '';
        input.click();
    };
    host.append(title, hint, grid, add, input, status);
    function render() {
        grid.replaceChildren();
        for (const item of items) {
            const cell = document.createElement('div');
            cell.className = 'photo-picker-item';
            const image = document.createElement('img');
            image.src = item.preview;
            image.alt = 'Выбранная работа мастера';
            const replace = document.createElement('button');
            replace.type = 'button';
            replace.textContent = 'Заменить';
            replace.disabled = busy || item.uploaded || !!savedSlot;
            replace.onclick = () => {
                input.dataset.replace = item.id;
                input.click();
            };
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Удалить';
            remove.disabled = busy;
            remove.onclick = async () => {
                busy = true;
                render();
                try {
                    if (savedSlot) {
                        try {
                            await photoRequest('delete', savedSlot, item.id);
                        } catch (error) {
                            if (error.code !== 'PHOTO_NOT_FOUND') throw error;
                        }
                    }
                    items = items.filter((p) => p !== item);
                    URL.revokeObjectURL(item.preview);
                    status.textContent = '';
                } catch (error) {
                    status.textContent = error.message;
                } finally {
                    busy = false;
                    render();
                }
            };
            cell.append(image, replace, remove);
            grid.append(cell);
        }
        add.hidden = items.length >= 3 || !!savedSlot;
        add.disabled = busy;
    }
    input.onchange = async () => {
        if (busy) return;
        const files = [...input.files];
        const replacement = input.dataset.replace;
        input.value = '';
        if (files.length > (replacement ? 1 : 3 - items.length)) {
            status.textContent = 'Можно выбрать не более 3 фото. Для замены выберите одно.';
            return;
        }
        busy = true;
        render();
        status.textContent = 'Подготавливаем фото…';
        try {
            // Prepare all first; failed selection leaves existing previews intact.
            const prepared = [];
            for (const file of files) {
                prepared.push({
                    id: crypto.randomUUID(),
                    blob: await preparePhoto(file),
                    uploaded: false,
                });
            }
            if (replacement) {
                const old = items.find((p) => p.id === replacement);
                items = items.filter((p) => p !== old);
                if (old) URL.revokeObjectURL(old.preview);
            }
            items.push(
                ...prepared.map((item) => ({
                    ...item,
                    preview: URL.createObjectURL(item.blob),
                })),
            );
            status.textContent = '';
        } catch (error) {
            status.textContent = error.message;
        } finally {
            busy = false;
            render();
        }
    };
    return {
        get busy() {
            return busy;
        },
        get slotId() {
            return savedSlot;
        },
        async upload(slotId) {
            savedSlot = slotId;
            busy = true;
            render();
            status.textContent = 'Слот создан. Загружаем фотографии…';
            try {
                // Reconcile a lost success response before retrying the same immutable upload IDs.
                const { photos } = items.length
                    ? await photoRequest('list', slotId)
                    : { photos: [] };
                for (const item of items) {
                    if (photos.some((p) => p.photo_id === item.id)) item.uploaded = true;
                    if (!item.uploaded) {
                        await photoRequest('upload', slotId, item.id, item.blob);
                        item.uploaded = true;
                    }
                }
                status.textContent = '';
            } catch (error) {
                status.textContent =
                    `Слот №${slotId} сохранён. ${error.message} Нажмите «Повторить загрузку фото».`;
                throw error;
            } finally {
                busy = false;
                render();
            }
        },
        reset() {
            items.forEach((p) => URL.revokeObjectURL(p.preview));
            items = [];
            savedSlot = null;
            status.textContent = '';
            render();
        },
    };
}
