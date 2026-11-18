import { attachAddressAutocomplete } from '../../components/address-autocomplete.js';

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
let publishing = false;

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
        city.value = '';
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
    document.dispatchEvent(new Event('bb:slot-form-reset'));
}


export async function createMasterSlot() {
    if (publishing) return;
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


    if (!city || city === 'Город') {
        showTelegramPopup('Укажите город.');
        document.getElementById('slot-city-input')?.focus();
        return;
    }

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


    const button = document.querySelector('#screen-master-add .publish-slot-button');
    publishing = true;
    if (button) button.disabled = true;

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
    } finally {
        publishing = false;
        if (button) button.disabled = false;
    }
}


export function initMasterAddSlot() {
    if (initialized) {
        return;
    }

    initialized = true;

    const cityInput = document.getElementById('slot-city-input');
    const addressInput = document.getElementById('slot-address-input');
    let selectedCity = null;
    const addressSuggestions = attachAddressAutocomplete(addressInput, {
        mode: 'address',
        context: () => ({ city: cityInput?.value.trim() || '', cityId: selectedCity?.cityId || null }),
    });
    attachAddressAutocomplete(cityInput, {
        mode: 'city',
        onSelect: (item) => { selectedCity = item; addressSuggestions?.close(); },
        onEdit: () => { selectedCity = null; addressSuggestions?.close(); },
    });
    // The successful create resets text and its transient geographic context together.
    document.addEventListener('bb:slot-form-reset', () => {
        selectedCity = null;
        addressSuggestions?.close();
    });


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
            '#screen-master-add .publish-slot-button'
        );


    if (publishButton) {
        publishButton.onclick = () => {
            createMasterSlot();
        };
    }


    loadMasterServices();

    setupCalendar();
}