import {
    ensureMaster,
    updateMasterName,
    updateMasterAddress,
    uploadMasterAvatar
} from '../../data/masters.js';

import {
    getTelegramUserId,
    getTelegramDisplayName,
    applyAvatars,
    openSupport,
    showTelegramPopup
} from '../../telegram.js';

let initialized = false;

export async function loadMasterProfile() {
    const masterId = getTelegramUserId();
    if (!masterId) return;

    try {
        const master = await ensureMaster(masterId);

        const name = document.getElementById('master-profile-name');
        const address = document.getElementById('master-address-input');

        if (name) {
            name.textContent = master?.name || getTelegramDisplayName();
            name.dataset.edited = 'true';
        }

        if (address) {
            address.value = master?.address || '';
        }

        applyAvatars('master');
    } catch (error) {
        console.error('Master profile loading error:', error);
    }
}

function setupNameEditing() {
    const element = document.getElementById('master-profile-name');
    if (!element) return;

    element.addEventListener('click', async () => {
        const newName = window.prompt(
            'Введите новый никнейм:',
            element.textContent.trim()
        );

        if (newName === null) return;

        try {
            const master = await updateMasterName(
                getTelegramUserId(),
                newName
            );

            element.textContent = master.name;
            element.dataset.edited = 'true';
        } catch (error) {
            showTelegramPopup(error.message || 'Не удалось изменить никнейм.');
        }
    });
}

function setupAddressEditing() {
    const input = document.getElementById('master-address-input');
    if (!input) return;

    input.addEventListener('blur', async () => {
        try {
            await updateMasterAddress(
                getTelegramUserId(),
                input.value
            );
        } catch (error) {
            showTelegramPopup('Не удалось сохранить адрес.');
        }
    });
}

function setupAvatarEditing() {
    const avatar = document.getElementById('master-profile-avatar');
    const input = document.getElementById('master-avatar-upload');

    if (!avatar || !input) return;

    avatar.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;

        try {
            await uploadMasterAvatar(getTelegramUserId(), file);
            applyAvatars('master');
            showTelegramPopup('Фото сохранено.');
        } catch (error) {
            showTelegramPopup(error.message || 'Не удалось сохранить фото.');
        } finally {
            input.value = '';
        }
    });
}

export function initMasterProfile() {
    if (initialized) return;
    initialized = true;

    setupNameEditing();
    setupAddressEditing();
    setupAvatarEditing();

    document.querySelector('#screen-master-profile .support-button')
        ?.addEventListener('click', openSupport);

    document.addEventListener('bb:navigation', async (event) => {
        if (event.detail?.screenId === 'screen-master-profile') {
            await loadMasterProfile();
        }
    });

    loadMasterProfile();
}