import { attachAddressAutocomplete } from '../../components/address-autocomplete.js';

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
let savedAddress = '';
let addressRevision = 0;
let addressWrites = Promise.resolve();

export async function loadMasterProfile() {
    const revision = addressRevision;
    try {
        await addressWrites;
        const master = await ensureMaster();

        const name = document.getElementById('master-profile-name');
        const address = document.getElementById('master-address-input');

        if (name) {
            name.textContent = master?.name || getTelegramDisplayName();
            name.dataset.edited = 'true';
        }

        if (address && revision === addressRevision) {
            address.value = master?.address || '';
            savedAddress = address.value;
        }

        applyAvatars('master');
    } catch (error) {
        console.error('Master profile loading error:', error);
        const name = document.getElementById('master-profile-name');
        if (name) {
            name.textContent = error.message || 'Не удалось загрузить профиль.';
            name.dataset.edited = 'false';
        }
    }
}

function setupNameEditing() {
    const element = document.getElementById('master-profile-name');
    if (!element) return;

    element.addEventListener('click', async () => {
        const newName = globalThis.prompt(
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

    input.addEventListener('input', () => { addressRevision++; });
    attachAddressAutocomplete(input, {
        mode: 'address',
        onSelect: () => { addressRevision++; },
    });
    const save = () => {
        const value = input.value.trim();
        // Serialize edits so an earlier slow request cannot overwrite a later selection.
        addressWrites = addressWrites.then(async () => {
            if (value === savedAddress) return;
            try {
                const master = await updateMasterAddress(getTelegramUserId(), value);
                savedAddress = master.address || '';
            } catch {
                showTelegramPopup('Не удалось сохранить адрес.');
            }
        });
        return addressWrites;
    };
    input.addEventListener('change', save);
    input.addEventListener('blur', save);
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
