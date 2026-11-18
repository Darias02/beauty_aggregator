import { photoRequest, preparePhoto } from '../data/slot-photos.js';

// Load on demand; refresh before expiry and on foregrounding. No signed URLs are persisted.
export function attachSlotPhotos(
    host,
    slotId,
    { compact = false, manage = false } = {},
) {
    const section = document.createElement('div');
    section.className = 'slot-photo-gallery';
    section.hidden = true;
    host.append(section);
    let refreshing = false;
    let lastForced = 0;
    let expires = 0;
    let photos = [];
    let pending = [];
    let dialog = null;
    let selected = null;
    let timer;
    function imageFailed() {
        if (Date.now() - lastForced < 30000) return;
        lastForced = Date.now();
        refresh(true);
    }
    function close() {
        dialog?.close();
        dialog?.remove();
        dialog = null;
        selected = null;
    }
    function show(photo) {
        close();
        selected = photo.photo_id;
        dialog = document.createElement('dialog');
        dialog.className = 'photo-lightbox';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Закрыть';
        button.onclick = close;
        const image = document.createElement('img');
        image.src = photo.url;
        image.alt = 'Работа мастера';
        image.onerror = imageFailed;
        dialog.append(button, image);
        document.body.append(dialog);
        dialog.addEventListener('cancel', close);
        dialog.showModal();
    }
    function render() {
        section.replaceChildren();
        section.hidden = !photos.length && !manage;
        const expanded = !compact || host.closest('details')?.open;
        photos.slice(0, expanded ? 3 : 1).forEach((photo, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'slot-photo-thumb';
            button.setAttribute(
                'aria-label',
                `Открыть фото ${index + 1} из ${photos.length}`,
            );
            const image = document.createElement('img');
            image.src = photo.url;
            image.alt = 'Работа мастера';
            image.loading = 'lazy';
            image.onerror = imageFailed;
            button.append(image);
            if (!expanded && photos.length > 1) {
                const count = document.createElement('span');
                count.textContent = `+${photos.length - 1}`;
                button.append(count);
            }
            button.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                show(photo);
            };
            section.append(button);
        });
        if (manage) {
            const controls = document.createElement('div');
            controls.className = 'photo-manage';
            const status = document.createElement('span');
            status.setAttribute('role', 'status');
            const perform = async (work) => {
                controls.querySelectorAll('button').forEach((b) => {
                    b.disabled = true;
                });
                try {
                    await work();
                    expires = 0;
                    await refresh();
                } catch (error) {
                    status.textContent = error.message;
                } finally {
                    controls.querySelectorAll('button').forEach((b) => {
                        b.disabled = false;
                    });
                }
            };
            pending.forEach((id) => {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.textContent = 'Удалить незавершённую загрузку';
                remove.onclick = () => perform(() => photoRequest('delete', slotId, id));
                controls.append(remove);
            });
            photos.forEach((photo, index) => {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.textContent = `Удалить фото ${index + 1}`;
                remove.onclick = () =>
                    perform(() => photoRequest('delete', slotId, photo.photo_id));
                controls.append(remove);
            });
            if (photos.length + pending.length < 3) {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/jpeg,image/png,image/webp';
                input.hidden = true;
                const add = document.createElement('button');
                add.type = 'button';
                add.textContent = 'Добавить фото';
                add.onclick = () => input.click();
                input.onchange = () => {
                    const file = input.files[0];
                    input.value = '';
                    if (file) {
                        const id = crypto.randomUUID();
                        perform(async () => {
                            const blob = await preparePhoto(file);
                            const retry = async () => {
                                await photoRequest('upload', slotId, id, blob);
                                expires = 0;
                            };
                            try {
                                await retry();
                            } catch (error) {
                                const button = document.createElement('button');
                                button.type = 'button';
                                button.textContent = 'Повторить загрузку';
                                button.onclick = () => perform(retry);
                                controls.append(button);
                                throw error;
                            }
                        });
                    }
                };
                controls.append(add, input);
            }
            controls.append(status);
            section.append(controls);
        }
        if (selected && dialog) {
            const current = photos.find((photo) => photo.photo_id === selected);
            if (current) dialog.querySelector('img').src = current.url;
            else close();
        }
    }
    async function refresh(force = false) {
        if (!host.isConnected) {
            clearTimeout(timer);
            close();
            document.removeEventListener('visibilitychange', foreground);
            document.removeEventListener('bb:navigation', close);
            return;
        }
        if (refreshing || (!force && expires > Date.now() + 60000)) return;
        refreshing = true;
        try {
            const result = await photoRequest('list', slotId);
            photos = result.photos;
            pending = result.pending || [];
            expires = photos.length
                ? Math.min(...photos.map((p) => p.expires_at))
                : Date.now() + 300000;
            render();
        } catch {
            // Slot text and booking remain usable if the photo service is unavailable.
            section.hidden = false;
            section.replaceChildren();
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'photo-retry';
            retry.textContent = 'Повторить загрузку фото';
            retry.onclick = () => refresh(true);
            section.append(retry);
        } finally {
            refreshing = false;
            clearTimeout(timer);
            timer = setTimeout(
                () => refresh(),
                Math.max(30000, Math.min(300000, expires - Date.now() - 60000)),
            );
        }
    }
    const foreground = () => {
        if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', foreground);
    document.addEventListener('bb:navigation', close);
    host.closest('details')?.addEventListener('toggle', render);
    // Caller can attach before insertion into the document.
    queueMicrotask(() => refresh());
}
