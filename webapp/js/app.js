import { state, setRole } from './state.js';
import { createRouter } from './router.js';
import { initNavigation } from './navigation.js';
import { initTelegram } from './telegram.js';
import { initModals } from './modals.js';

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


const MODEL_MENU = 'screen-model-menu';
const MODEL_SEARCH = 'screen-model-search';
const MODEL_RECORDS = 'screen-model-records';
const MODEL_PROFILE = 'screen-model-profile';
const MODEL_SUCCESS = 'screen-model-success';

const MASTER_MENU = 'screen-master-menu';
const MASTER_RECORDS = 'screen-master-records';
const MASTER_PROFILE = 'screen-master-profile';
const MASTER_ADD = 'screen-master-add';
const MASTER_SUCCESS = 'screen-master-success';


const navStructure = {
    model: [
        {
            id: 'menu',
            text: 'Меню',
            screen: MODEL_MENU
        },
        {
            id: 'search',
            text: 'Поиск',
            screen: MODEL_SEARCH
        },
        {
            id: 'records',
            text: 'Записи',
            screen: MODEL_RECORDS
        },
        {
            id: 'profile',
            text: 'Профиль',
            screen: MODEL_PROFILE
        }
    ],

    master: [
        {
            id: 'menu',
            text: 'Меню',
            screen: MASTER_MENU
        },
        {
            id: 'records',
            text: 'Слоты',
            screen: MASTER_RECORDS
        },
        {
            id: 'profile',
            text: 'Профиль',
            screen: MASTER_PROFILE
        }
    ]
};



window.toggleDropdown = function (id) {
    const element = document.getElementById(id);

    if (!element) {
        return;
    }

    element.classList.toggle('active');
};


window.selectItem = function (
    spanId,
    dropId,
    name,
    event
) {
    if (event) {
        event.stopPropagation();
    }

    const target = document.getElementById(spanId);
    const dropdown = document.getElementById(dropId);

    if (target) {
        target.innerText = name;
    }

    if (dropdown) {
        dropdown.classList.remove('active');
    }

    document.dispatchEvent(
        new CustomEvent('bb:item-selected', {
            detail: {
                elementId: spanId,
                value: name
            }
        })
    );
};



function initDropdownClosing() {
    document.addEventListener('click', function (event) {
        const cityDropdown =
            document.getElementById('city-dropdown');

        const serviceDropdown =
            document.getElementById('service-dropdown');

        if (
            cityDropdown &&
            !event.target.closest('.input-box')
        ) {
            cityDropdown.classList.remove('active');
        }

        if (
            serviceDropdown &&
            !event.target.closest('.input-box')
        ) {
            serviceDropdown.classList.remove('active');
        }
    });
}



let router = null;


function navigate(screenId, options = {}) {
    if (!router) {
        return;
    }

    router.navigate(screenId, options);
}


window.navigate = navigate;



window.switchRole = function (role) {
    if (role !== 'model' && role !== 'master') {
        return;
    }

    setRole(role);

    const target =
        role === 'model'
            ? MODEL_MENU
            : MASTER_MENU;

    navigate(target);
};



async function initScreens() {
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



function initRoleNavigation() {
    initNavigation({
        navStructure,
        getCurrentRole: () => state.currentRole,
        navigate
    });
}



async function bootstrap() {
    try {
        initTelegram();

        router = createRouter({
            defaultScreen: MODEL_MENU,
            getCurrentRole: () => state.currentRole
        });

        initRoleNavigation();

        initModals({
            navigate
        });

        initDropdownClosing();

        await initScreens();

        router.start();

        if (
            window.Telegram &&
            window.Telegram.WebApp
        ) {
            window.Telegram.WebApp.expand();
        }

    } catch (error) {
        console.error(
            'Beauty Booking initialization error:',
            error
        );
    }
}



if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        bootstrap
    );
} else {
    bootstrap();
}