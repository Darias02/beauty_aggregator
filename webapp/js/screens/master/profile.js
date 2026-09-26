import {
    createOrUpdateUser,
    updateUserName
} from '../../data/users.js';

import {
    getTelegramUser,
    getTelegramUserId,
    getTelegramDisplayName,
    applyAvatars,
    setupMasterAvatarUpload
} from '../../telegram.js';

import {
    setUser
} from '../../state.js';


let initialized = false;


export async function loadMasterProfile() {
    const masterId =
        getTelegramUserId();


    if (!masterId) {
        return;
    }


    const tgUser =
        getTelegramUser();


    const defaultName =
        getTelegramDisplayName();


    const nameElement =
        document.getElementById(
            'master-profile-name'
        );


    if (nameElement) {
        nameElement.textContent =
            defaultName;
    }


    applyAvatars(
        'master'
    );


    try {
        const user =
            await createOrUpdateUser({
                userId: masterId,
                name:
                    tgUser?.username
                        ? `@${tgUser.username}`
                        : defaultName
            });


        if (user) {
            setUser(user);
        }

    } catch (error) {
        console.error(
            'Master profile loading error:',
            error
        );
    }
}


function setupNameEditing() {
    const element =
        document.getElementById(
            'master-profile-name'
        );


    if (!element) {
        return;
    }


    element.addEventListener(
        'click',
        async () => {
            const currentName =
                element.textContent.trim();


            const newName =
                window.prompt(
                    'Введите новый никнейм:',
                    currentName
                );


            if (
                newName === null
            ) {
                return;
            }


            const cleanName =
                newName.trim();


            if (!cleanName) {
                alert(
                    'Никнейм не может быть пустым.'
                );

                return;
            }


            const userId =
                getTelegramUserId();


            if (!userId) {
                alert(
                    'Откройте приложение через Telegram.'
                );

                return;
            }


            try {
                const updatedUser =
                    await updateUserName(
                        userId,
                        cleanName
                    );


                element.textContent =
                    updatedUser?.name ||
                    cleanName;


                element.dataset.edited =
                    'true';


                setUser(
                    updatedUser
                );

            } catch (error) {
                console.error(
                    'Master name update error:',
                    error
                );

                alert(
                    'Не удалось изменить никнейм.'
                );
            }
        }
    );
}


export function initMasterProfile() {
    if (initialized) {
        return;
    }

    initialized = true;


    setupNameEditing();

    setupMasterAvatarUpload();


    document.addEventListener(
        'bb:navigation',
        async (event) => {
            if (
                event.detail?.screenId ===
                'screen-master-profile'
            ) {
                await loadMasterProfile();
            }
        }
    );


    loadMasterProfile();
}