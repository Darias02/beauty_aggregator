import {
    getServices
} from '../../data/services.js';

import {
    createSlot
} from '../../data/slots.js';

import {
    state,
    setSelectedService,
    setSelectedDate,
    resetSlotCreation
} from '../../state.js';

import {
    getTelegramUserId,
    hapticImpact,
    showTelegramPopup
} from '../../telegram.js';

import {
    initCalendar
} from '../../components/calendar.js';

import {
    navigate
} from '../../router.js';


let initialized = false;

let services = [];


export async function loadMasterServices() {
    const dropdown =
        document.getElementById(
            'service-dropdown'
        );


    if (!dropdown) {
        return;
    }


    dropdown.innerHTML =
        'Загрузка...';


    try {
        services =
            await getServices();


        dropdown.innerHTML =
            '';


        if (!services.length) {
            dropdown.innerHTML =
                '<div class="dropdown-item">Услуги не найдены</div>';

            return;
        }


        services.forEach(
            (service) => {
                const item =
                    document.createElement(
                        'div'
                    );


                item.className =
                    'dropdown-item';


                item.textContent =
                    service.name;


                item.addEventListener(
                    'click',
                    (event) => {
                        event.stopPropagation();

                        selectService(
                            service
                        );
                    }
                );


                dropdown.appendChild(
                    item
                );
            }
        );

    } catch (error) {
        console.error(
            'Master services loading error:',
            error
        );

        dropdown.innerHTML =
            '<div class="dropdown-item">Не удалось загрузить услуги</div>';
    }
}


function selectService(
    service
) {
    setSelectedService(
        service
    );


    const selectedElement =
        document.getElementById(
            'selected-service'
        );


    if (selectedElement) {
        selectedElement.textContent =
            service.name;
    }


    document
        .getElementById(
            'service-dropdown'
        )
        ?.classList
        .remove('active');


    hapticImpact('light');


    document.dispatchEvent(
        new CustomEvent(
            'bb:service-selected-for-slot',
            {
                detail: {
                    service
                }
            }
        )
    );
}


function setupCalendar() {
    initCalendar({
        gridId: 'calendar-grid',
        headerId: 'calendar-header',

        onSelect: (date) => {
            setSelectedDate(
                date
            );
        }
    });
}


function getSelectedService() {
    if (
        state.selectedServiceId
    ) {
        return services.find(
            (service) =>
                service.service_id ===
                state.selectedServiceId
        );
    }


    const selectedName =
        document
            .getElementById(
                'selected-service'
            )
            ?.textContent
            ?.trim();


    if (
        !selectedName ||
        selectedName ===
            'Выберите услугу'
    ) {
        return null;
    }


    return services.find(
        (service) =>
            service.name ===
            selectedName
    ) || null;
}


function buildDateTime() {
    const date =
        state.selectedDate;


    const time =
        document
            .getElementById(
                'slot-time-input'
            )
            ?.value
            ?.trim();


    if (!date || !time) {
        return null;
    }


    const [
        hours,
        minutes
    ] =
        time.split(':')
            .map(Number);


    const result =
        new Date(date);


    result.setHours(
        hours,
        minutes,
        0,
        0
    );


    return result;
}


function clearForm() {
    const selectedService =
        document.getElementById(
            'selected-service'
        );


    const city =
        document.getElementById(
            'slot-city-input'
        );


    const address =
        document.getElementById(
            'slot-address-input'
        );


    const description =
        document.getElementById(
            'slot-description-input'
        );


    const time =
        document.getElementById(
            'slot-time-input'
        );


    if (selectedService) {
        selectedService.textContent =
            'Выберите услугу';
    }


    if (city) {
        city.value =
            'Москва';
    }


    if (address) {
        address.value =
            '';
    }


    if (description) {
        description.value =
            '';
    }


    if (time) {
        time.value =
            '';
    }


    resetSlotCreation();
}


export async function createMasterSlot() {
    const masterId =
        getTelegramUserId();


    if (!masterId) {
        showTelegramPopup(
            'Откройте приложение через Telegram.'
        );

        return;
    }


    const service =
        getSelectedService();


    if (!service) {
        showTelegramPopup(
            'Выберите услугу.'
        );

        return;
    }


    const dateTime =
        buildDateTime();


    if (!dateTime) {
        showTelegramPopup(
            'Выберите дату и укажите время.'
        );

        return;
    }


    if (
        dateTime <=
        new Date()
    ) {
        showTelegramPopup(
            'Выберите будущее время.'
        );

        return;
    }


    const city =
        document
            .getElementById(
                'slot-city-input'
            )
            ?.value
            ?.trim() || '';


    const address =
        document
            .getElementById(
                'slot-address-input'
            )
            ?.value
            ?.trim() || '';


    const description =
        document
            .getElementById(
                'slot-description-input'
            )
            ?.value
            ?.trim() || '';


    try {
        hapticImpact('medium');


        await createSlot({
            masterId,
            serviceId:
                service.service_id,
            dateTime:
                dateTime.toISOString(),
            city,
            address,
            description
        });


        clearForm();


        navigate(
            'screen-master-success'
        );

    } catch (error) {
        console.error(
            'Create master slot error:',
            error
        );

        showTelegramPopup(
            error.message ||
            'Не удалось создать слот.'
        );
    }
}


export function initMasterAddSlot() {
    if (initialized) {
        return;
    }

    initialized = true;


    document.addEventListener(
        'bb:navigation',
        async (event) => {
            if (
                event.detail?.screenId ===
                'screen-master-add'
            ) {
                await loadMasterServices();

                setupCalendar();
            }
        }
    );


    const publishButton =
        document.querySelector(
            '#screen-master-add .btn-primary:last-child'
        );


    if (publishButton) {
        publishButton.onclick = () => {
            createMasterSlot();
        };
    }


    loadMasterServices();

    setupCalendar();
}