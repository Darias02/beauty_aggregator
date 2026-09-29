import { state, setRole } from './state.js';
import { createRouter } from './router.js';
import { initNavigation } from './navigation.js';
import { initTelegram, getTelegramUserId, showTelegramPopup } from './telegram.js';
import { initModals } from './modals.js';
import { ensureMaster } from './data/masters.js';

import { initModelMenu } from './screens/model/menu.js';
import { initModelSearch } from './screens/model/search.js';
import { initModelRecords } from './screens/model/records.js';
import { initModelProfile } from './screens/model/profile.js';
import { initModelSuccess } from './screens/model/success.js';
import { initMasterMenu } from './screens/master/menu.js';
import { initMasterRecords } from './screens/master/records.js';
import { initMasterProfile } from './screens/master/profile.js';
import { initMasterAddSlot } from './screens/master/add-slot.js';
import { initMasterSuccess } from './screens/master/success.js';

const navStructure = {
    model: [
        { id: 'menu', text: 'Меню', screen: 'screen-model-menu' },
        { id: 'search', text: 'Поиск', screen: 'screen-model-search' },
        { id: 'records', text: 'Записи', screen: 'screen-model-records' },
        { id: 'profile', text: 'Профиль', screen: 'screen-model-profile' }
    ],
    master: [
        { id: 'menu', text: 'Меню', screen: 'screen-master-menu' },
        { id: 'records', text: 'Слоты', screen: 'screen-master-records' },
        { id: 'profile', text: 'Профиль', screen: 'screen-master-profile' }
    ]
};

window.toggleDropdown = (id) => {
    document.getElementById(id)?.classList.toggle('active');
};

window.selectItem = (spanId, dropId, name, event) => {
    event?.stopPropagation();
    const target = document.getElementById(spanId);
    const dropdown = document.getElementById(dropId);
    if (target) target.textContent = name;
    dropdown?.classList.remove('active');

    document.dispatchEvent(new CustomEvent('bb:item-selected', {
        detail: { elementId: spanId, value: name }
    }));
};

document.addEventListener('click', (event) => {
    document.querySelectorAll('.dropdown-menu.active').forEach((dropdown) => {
        if (!event.target.closest('.input-box')) {
            dropdown.classList.remove('active');
        }
    });
});

let router = null;

function navigate(screenId, options = {}) {
    router?.navigate(screenId, options);
}

window.navigate = navigate;

window.switchRole = async (role) => {
    if (!['model', 'master'].includes(role)) return;

    if (role === 'master') {
        const userId = getTelegramUserId();

        if (!userId) {
            showTelegramPopup('Откройте приложение через Telegram.');
            return;
        }

        try {
            await ensureMaster(userId);
        } catch (error) {
            console.error('Master registration error:', error);
            showTelegramPopup('Не удалось открыть профиль мастера.');
            return;
        }
    }

    setRole(role);
    navigate(role === 'model' ? 'screen-model-menu' : 'screen-master-menu');
};

function initScreens() {
    initModelMenu();
    initModelSearch();
    initModelRecords();
    initModelProfile();
    initModelSuccess();
    initMasterMenu();
    initMasterRecords();
    initMasterProfile();
    initMasterAddSlot();
    initMasterSuccess();
}

function bootstrap() {
    try {
        initTelegram();

        router = createRouter({
            defaultScreen: 'screen-model-menu',
            getCurrentRole: () => state.currentRole
        });

        initNavigation({
            navStructure,
            getCurrentRole: () => state.currentRole,
            navigate
        });

        initModals();
        initScreens();
        router.start();
    } catch (error) {
        console.error('BB initialization error:', error);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}