import {
    createOrUpdateUser,
    updateUserName
} from '../../data/users.js';

import {
    getTelegramUser,
    getTelegramUserId,
    getTelegramDisplayName,
    applyAvatars
} from '../../telegram.js';

import {
    setUser,
    state
} from '../../state.js';


let initialized = false;


export async function loadModelProfile() {
    const userId =
        getTelegramUserId();


    if (!userId) {
        return;
    }


    const tgUser =
        getTelegramUser();


    const defaultName =
        getTelegramDisplayName();


    const nameElement =
        document.getElementById(
            'model-profile-name'
        );


    if (nameElement) {
        nameElement.textContent =
            defaultName;
    }


    applyAvatars(
        'model'
    );


    try {
        const user =
            await createOrUpdateUser({
                userId,
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
            'Model profile loading error:',
            error
        );
    }
}


function setupNameEditing() {
    const element =
        document.getElementById(
            'model-profile-name'
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
                    'Profile name update error:',
                    error
                );

                alert(
                    'Не удалось изменить никнейм.'
                );
            }
        }
    );
}


export function initModelProfile() {
    if (initialized) {
        return;
    }

    initialized = true;


    setupNameEditing();


    document.addEventListener(
        'bb:navigation',
        async (event) => {
            if (
                event.detail?.screenId ===
                'screen-model-profile'
            ) {
                await loadModelProfile();
            }
        }
    );


    loadModelProfile();
}