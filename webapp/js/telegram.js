import {
    setUser,
    state
} from './state.js';


const MASTER_AVATAR_KEY =
    'bb_master_custom_avatar';


function getTelegramWebApp() {
    return window.Telegram?.WebApp || null;
}


export function getTelegramUser() {
    const tg = getTelegramWebApp();

    return tg?.initDataUnsafe?.user || null;
}


export function getTelegramUserId() {
    const user = getTelegramUser();

    return user?.id || null;
}


export function getTelegramUsername() {
    const user = getTelegramUser();

    if (!user) {
        return null;
    }

    if (user.username) {
        return `@${user.username}`;
    }

    const fullName = [
        user.first_name,
        user.last_name
    ]
        .filter(Boolean)
        .join(' ')
        .trim();

    return fullName || null;
}


export function getTelegramDisplayName() {
    const user = getTelegramUser();

    if (!user) {
        return 'Никнейм';
    }

    if (user.username) {
        return `@${user.username}`;
    }

    return [
        user.first_name,
        user.last_name
    ]
        .filter(Boolean)
        .join(' ')
        .trim() || 'Никнейм';
}


export function getTelegramPhotoUrl() {
    const user = getTelegramUser();

    return user?.photo_url || null;
}


export function getCustomMasterAvatar() {
    try {
        return localStorage.getItem(
            MASTER_AVATAR_KEY
        );
    } catch (error) {
        console.warn(
            'Cannot read master avatar:',
            error
        );

        return null;
    }
}


export function saveCustomMasterAvatar(
    dataUrl
) {
    try {
        localStorage.setItem(
            MASTER_AVATAR_KEY,
            dataUrl
        );

        return true;
    } catch (error) {
        console.warn(
            'Cannot save master avatar:',
            error
        );

        return false;
    }
}


export function removeCustomMasterAvatar() {
    try {
        localStorage.removeItem(
            MASTER_AVATAR_KEY
        );
    } catch (error) {
        console.warn(
            'Cannot remove master avatar:',
            error
        );
    }
}


export function getCurrentAvatarUrl(
    role = state.currentRole
) {
    if (role === 'master') {
        return (
            getCustomMasterAvatar() ||
            getTelegramPhotoUrl()
        );
    }

    return getTelegramPhotoUrl();
}


function setElementAvatar(
    element,
    avatarUrl
) {
    if (!element) {
        return;
    }

    if (avatarUrl) {
        element.style.backgroundImage =
            `url("${avatarUrl}")`;

        element.textContent = '';
        return;
    }

    element.style.backgroundImage = '';
}


export function applyAvatars(
    role = state.currentRole
) {
    const avatarUrl =
        getCurrentAvatarUrl(role);

    document
        .querySelectorAll('[data-avatar]')
        .forEach((element) => {
            setElementAvatar(
                element,
                avatarUrl
            );
        });


    const modelProfileAvatar =
        document.getElementById(
            'model-profile-avatar'
        );

    const masterProfileAvatar =
        document.getElementById(
            'master-profile-avatar'
        );


    setElementAvatar(
        modelProfileAvatar,
        getCurrentAvatarUrl('model')
    );


    setElementAvatar(
        masterProfileAvatar,
        getCurrentAvatarUrl('master')
    );
}


export function applyUserNames() {
    const displayName =
        getTelegramDisplayName();


    const modelName =
        document.getElementById(
            'model-profile-name'
        );

    const masterName =
        document.getElementById(
            'master-profile-name'
        );


    if (
        modelName &&
        (
            modelName.textContent.trim() ===
                'Никнейм' ||
            !modelName.dataset.edited
        )
    ) {
        modelName.textContent =
            displayName;
    }


    if (
        masterName &&
        (
            masterName.textContent.trim() ===
                'Никнейм' ||
            !masterName.dataset.edited
        )
    ) {
        masterName.textContent =
            displayName;
    }
}


export function setupMasterAvatarUpload() {
    const avatar =
        document.getElementById(
            'master-profile-avatar'
        );

    const input =
        document.getElementById(
            'master-avatar-upload'
        );


    if (!avatar || !input) {
        return;
    }


    avatar.addEventListener(
        'click',
        () => {
            input.click();
        }
    );


    input.addEventListener(
        'change',
        (event) => {
            const file =
                event.target.files?.[0];

            if (!file) {
                return;
            }


            if (!file.type.startsWith('image/')) {
                alert(
                    'Выберите изображение.'
                );

                input.value = '';
                return;
            }


            const reader =
                new FileReader();


            reader.onload = () => {
                const dataUrl =
                    reader.result;


                if (
                    typeof dataUrl !==
                    'string'
                ) {
                    return;
                }


                const saved =
                    saveCustomMasterAvatar(
                        dataUrl
                    );


                if (!saved) {
                    alert(
                        'Не удалось сохранить фотографию.'
                    );

                    return;
                }


                applyAvatars(
                    state.currentRole
                );
            };


            reader.readAsDataURL(file);
        }
    );
}


export function initTelegram() {
    const tg = getTelegramWebApp();

    if (tg) {
        try {
            tg.ready();
            tg.expand();

            if (
                typeof tg.setHeaderColor ===
                'function'
            ) {
                tg.setHeaderColor('#000000');
            }

            if (
                typeof tg.setBackgroundColor ===
                'function'
            ) {
                tg.setBackgroundColor('#000000');
            }
        } catch (error) {
            console.warn(
                'Telegram initialization warning:',
                error
            );
        }
    }


    const telegramUser =
        getTelegramUser();

    setUser(telegramUser);

    applyAvatars(
        state.currentRole
    );

    applyUserNames();

    setupMasterAvatarUpload();
}


export function hapticImpact(
    style = 'light'
) {
    try {
        getTelegramWebApp()
            ?.HapticFeedback
            ?.impactOccurred(style);
    } catch (error) {
        console.warn(
            'Haptic feedback unavailable:',
            error
        );
    }
}


export function showTelegramPopup(
    message,
    title = 'BB'
) {
    const tg =
        getTelegramWebApp();


    if (
        tg &&
        typeof tg.showPopup ===
        'function'
    ) {
        tg.showPopup({
            title,
            message,
            buttons: [
                {
                    id: 'ok',
                    type: 'ok'
                }
            ]
        });

        return;
    }


    alert(message);
}