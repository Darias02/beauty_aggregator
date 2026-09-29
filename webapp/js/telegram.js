import { setUser, state } from './state.js';

let masterAvatarUrl = null;

function getTelegramWebApp() {
    return window.Telegram?.WebApp || null;
}

export function getTelegramUser() {
    return getTelegramWebApp()?.initDataUnsafe?.user || null;
}

export function getTelegramUserId() {
    return getTelegramUser()?.id || null;
}

export function getTelegramInitData() {
    return getTelegramWebApp()?.initData || '';
}

export function getTelegramUsername() {
    const user = getTelegramUser();
    if (!user) return null;
    if (user.username) return `@${user.username}`;

    return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || null;
}

export function getTelegramDisplayName() {
    return getTelegramUsername() || 'Никнейм';
}

export function getTelegramPhotoUrl() {
    return getTelegramUser()?.photo_url || null;
}

export function setMasterAvatarUrl(url) {
    masterAvatarUrl = url || null;
    applyAvatars('master');
}

export function getCurrentAvatarUrl(role = state.currentRole) {
    return role === 'master'
        ? masterAvatarUrl || getTelegramPhotoUrl()
        : getTelegramPhotoUrl();
}

function setElementAvatar(element, avatarUrl) {
    if (!element) return;
    element.style.backgroundImage = avatarUrl ? `url("${avatarUrl}")` : '';
    element.textContent = '';
}

export function applyAvatars(role = state.currentRole) {
    const sharedAvatarUrl = getCurrentAvatarUrl(role);

    document.querySelectorAll('[data-avatar]').forEach((element) => {
        setElementAvatar(element, sharedAvatarUrl);
    });

    setElementAvatar(
        document.getElementById('model-profile-avatar'),
        getCurrentAvatarUrl('model')
    );

    setElementAvatar(
        document.getElementById('master-profile-avatar'),
        getCurrentAvatarUrl('master')
    );
}

export function initTelegram() {
    const tg = getTelegramWebApp();

    if (tg) {
        try {
            tg.ready();
            tg.expand();
            tg.setHeaderColor?.('#000000');
            tg.setBackgroundColor?.('#000000');
        } catch (error) {
            console.warn('Telegram initialization warning:', error);
        }
    }

    setUser(getTelegramUser());
    applyAvatars(state.currentRole);
}

export function hapticImpact(style = 'light') {
    try {
        getTelegramWebApp()?.HapticFeedback?.impactOccurred(style);
    } catch (error) {
        console.warn('Haptic feedback unavailable:', error);
    }
}

export function showTelegramPopup(message, title = 'BB') {
    const tg = getTelegramWebApp();

    if (tg?.showPopup) {
        tg.showPopup({
            title,
            message,
            buttons: [{ id: 'ok', type: 'ok' }]
        });
        return;
    }

    alert(message);
}

export function openSupport() {
    const tg = getTelegramWebApp();

    if (tg?.openTelegramLink) {
        tg.openTelegramLink('https://t.me/darghff');
        return;
    }

    window.open('https://t.me/darghff', '_blank');
}