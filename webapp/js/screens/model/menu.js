import {
    getServices,
    getAvailableServiceCounts
} from '../../data/services.js';

import {
    renderServiceCards
} from '../../components/service-card.js';

import {
    showSkeleton
} from '../../components/skeleton.js';

import {
    setSelectedService
} from '../../state.js';

import {
    navigate
} from '../../router.js';


let initialized = false;
let services = [];


export async function loadModelMenu() {
    const container =
        document.getElementById(
            'model-menu-services'
        );

    if (!container) {
        return;
    }


    showSkeleton(
        container,
        'Загружаем услуги...'
    );


    try {
        services =
            await getServices();

        const counts =
            await getAvailableServiceCounts();


        renderServiceCards({
            container,
            services,
            counts,

            onSelect: (service) => {
                setSelectedService(
                    service
                );

                navigate(
                    'screen-model-search'
                );
            }
        });

    } catch (error) {
        console.error(
            'Model menu loading error:',
            error
        );

        showSkeleton(
            container,
            'Не удалось загрузить услуги'
        );
    }
}


export function initModelMenu() {
    if (initialized) {
        return;
    }

    initialized = true;


    document.addEventListener(
        'bb:navigation',
        (event) => {
            if (
                event.detail?.screenId ===
                'screen-model-menu'
            ) {
                loadModelMenu();
            }
        }
    );


    loadModelMenu();
}


export function getModelServices() {
    return services;
}