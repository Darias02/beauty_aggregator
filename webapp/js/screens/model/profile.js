import { ensureOwnProfile, updateOwnProfileName } from '../../data/users.js';
import { applyAvatars, openSupport, showTelegramPopup } from '../../telegram.js';
import { setUser } from '../../state.js';

let initialized = false;
let profileLoaded = false;
let loading = null;
let saving = false;

export async function loadModelProfile() {
    if (saving) return;
    if (loading) return loading;
    loading = (async () => {
        const name = document.getElementById('model-profile-name');
        profileLoaded = false;
        try {
            const user = await ensureOwnProfile();
            setUser(user);
            profileLoaded = true;
            applyAvatars('model');
            if (name) {
                name.textContent = user.name;
                name.dataset.edited = 'true';
            }
        } catch (error) {
            setUser(null);
            if (name) {
                name.textContent = error.message || 'Не удалось загрузить профиль.';
                name.dataset.edited = 'false';
            }
        }
    })();
    try {
        await loading;
    } finally {
        loading = null;
    }
}

function setupNameEditing() {
    const element = document.getElementById('model-profile-name');
    if (!element) return;

    element.addEventListener('click', async () => {
        if (!profileLoaded) {
            await loadModelProfile();
            return;
        }
        if (saving || loading) return;
        const newName = globalThis.prompt(
            'Введите новый никнейм:',
            element.textContent.trim(),
        );

        if (newName === null) return;

        saving = true;
        try {
            const updated = await updateOwnProfileName(newName);

            element.textContent = updated.name;
            element.dataset.edited = 'true';
            setUser(updated);
        } catch (error) {
            if (error.code === 'UNAUTHORIZED') {
                profileLoaded = false;
                setUser(null);
                element.textContent = error.message;
                element.dataset.edited = 'false';
            }
            showTelegramPopup(error.message || 'Не удалось изменить никнейм.');
        } finally {
            saving = false;
        }
    });
}

export function initModelProfile() {
    if (initialized) return;
    initialized = true;

    setupNameEditing();
    document.querySelector('#screen-model-profile .support-button')
        ?.addEventListener('click', openSupport);

    document.addEventListener('bb:navigation', async (event) => {
        if (event.detail?.screenId === 'screen-model-profile') {
            await loadModelProfile();
        }
    });

    loadModelProfile();
}
