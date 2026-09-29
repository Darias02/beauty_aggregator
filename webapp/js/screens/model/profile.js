import { createOrUpdateUser, updateUserName } from '../../data/users.js';
import {
    getTelegramUser,
    getTelegramUserId,
    getTelegramDisplayName,
    applyAvatars,
    openSupport,
    showTelegramPopup
} from '../../telegram.js';
import { setUser } from '../../state.js';

let initialized = false;

export async function loadModelProfile() {
    const userId = getTelegramUserId();
    if (!userId) return;

    try {
        const tgUser = getTelegramUser();
        const user = await createOrUpdateUser({
            userId,
            name: tgUser?.username ? `@${tgUser.username}` : getTelegramDisplayName()
        });

        setUser(user);
        applyAvatars('model');

        const name = document.getElementById('model-profile-name');
        if (name) {
            name.textContent = user?.name || getTelegramDisplayName();
            name.dataset.edited = 'true';
        }
    } catch (error) {
        console.error('Model profile loading error:', error);
    }
}

function setupNameEditing() {
    const element = document.getElementById('model-profile-name');
    if (!element) return;

    element.addEventListener('click', async () => {
        const newName = window.prompt(
            'Введите новый никнейм:',
            element.textContent.trim()
        );

        if (newName === null) return;

        try {
            const updated = await updateUserName(
                getTelegramUserId(),
                newName
            );

            element.textContent = updated.name;
            element.dataset.edited = 'true';
            setUser(updated);
        } catch (error) {
            showTelegramPopup(error.message || 'Не удалось изменить никнейм.');
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