import {
    getServices
} from '../../data/services.js';

import {
    getAvailableSlots
} from '../../data/slots.js';

import {
    createBooking
} from '../../data/bookings.js';

import {
    showSkeleton
} from '../../components/skeleton.js';

import {
    state,
    setSelectedService,
    setSelectedCity,
    setSelectedSlot
} from '../../state.js';

import {
    getTelegramUserId,
    hapticImpact,
    showTelegramPopup
} from '../../telegram.js';

import {
    navigate
} from '../../router.js';


let initialized = false;
let services = [];


export async function loadSearchServices() {
    try {
        services =
            await getServices();

        renderServiceTags();

        const selectedService =
            findCurrentService();


        if (selectedService) {
            setSelectedService(
                selectedService
            );
        }

        await renderSearchResults();

    } catch (error) {
        console.error(
            'Search services loading error:',
            error
        );
    }
}


function findCurrentService() {
    if (
        state.selectedServiceId
    ) {
        return services.find(
            (service) =>
                service.service_id ===
                state.selectedServiceId
        );
    }


    if (
        state.selectedServiceName
    ) {
        return services.find(
            (service) =>
                service.name ===
                state.selectedServiceName
        );
    }


    return services[0] || null;
}


function renderServiceTags() {
    const container =
        document.getElementById(
            'service-tags'
        );

    if (!container) {
        return;
    }


    container.innerHTML = '';


    services.forEach(
        (service) => {
            const tag =
                document.createElement(
                    'div'
                );


            tag.className =
                'tag';


            if (
                service.service_id ===
                state.selectedServiceId
            ) {
                tag.classList.add(
                    'active'
                );
            }


            tag.textContent =
                service.name;


            tag.addEventListener(
                'click',
                async () => {
                    hapticImpact('light');

                    setSelectedService(
                        service
                    );

                    renderServiceTags();

                    await renderSearchResults();
                }
            );


            container.appendChild(tag);
        }
    );
}


function getSelectedCityFromDom() {
    const element =
        document.getElementById(
            'selected-city'
        );

    const value =
        element?.textContent?.trim();


    if (
        !value ||
        value === 'Город'
    ) {
        return null;
    }


    return value;
}


function formatDateTime(
    value
) {
    const date =
        new Date(value);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return {
            date: '',
            time: ''
        };
    }


    return {
        date: date.toLocaleDateString(
            'ru-RU',
            {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }
        ),

        time: date.toLocaleTimeString(
            'ru-RU',
            {
                hour: '2-digit',
                minute: '2-digit'
            }
        )
    };
}


function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}


function renderEmptyState(
    container,
    text
) {
    container.innerHTML = `
        <div
            class="service-card skeleton-card"
        >
            <div class="skeleton-text">
                ${escapeHtml(text)}
            </div>
        </div>
    `;
}


export async function renderSearchResults() {
    const container =
        document.getElementById(
            'model-search-results'
        );

    if (!container) {
        return;
    }


    const selectedService =
        findCurrentService();


    if (!selectedService) {
        renderEmptyState(
            container,
            'Выберите услугу'
        );

        return;
    }


    setSelectedService(
        selectedService
    );


    const city =
        state.selectedCity ||
        getSelectedCityFromDom();


    setSelectedCity(city);


    showSkeleton(
        container,
        'Ищем свободные слоты...'
    );


    try {
        const slots =
            await getAvailableSlots(
                selectedService.service_id,
                city
            );


        container.innerHTML = '';


        if (!slots.length) {
            renderEmptyState(
                container,
                city
                    ? 'Свободных слотов в выбранном городе пока нет'
                    : 'Свободных слотов пока нет'
            );

            return;
        }


        slots.forEach(
            (slot) => {
                container.appendChild(
                    createSlotCard(
                        slot,
                        selectedService
                    )
                );
            }
        );

    } catch (error) {
        console.error(
            'Search results error:',
            error
        );

        renderEmptyState(
            container,
            'Не удалось загрузить свободные слоты'
        );
    }
}


function createSlotCard(
    slot,
    service
) {
    const card =
        document.createElement('div');


    card.className =
        'service-card';


    const {
        date,
        time
    } =
        formatDateTime(
            slot.date_time
        );


    card.innerHTML = `
        <div class="service-header">

            <div class="service-left">

                <div
                    class="service-icon"
                    ${
                        service?.icon_url
                            ? `style="
                                background-image:url('${escapeHtml(
                                    service.icon_url
                                )}');
                                background-size:cover;
                                background-position:center;
                            "`
                            : ''
                    }
                >
                    ${
                        service?.icon_url
                            ? ''
                            : 'BB'
                    }
                </div>

                <div>

                    <div class="service-title">
                        ${escapeHtml(
                            service?.name ||
                            'Услуга'
                        )}
                    </div>

                    <div class="service-time">
                        ${escapeHtml(date)}
                        ${
                            time
                                ? ` · ${escapeHtml(time)}`
                                : ''
                        }
                    </div>

                </div>

            </div>

        </div>

        <div class="service-status">
            ${
                slot.city
                    ? escapeHtml(slot.city)
                    : ''
            }
        </div>

        ${
            slot.address
                ? `
                    <div class="details-text">
                        Адрес:
                        ${escapeHtml(
                            slot.address
                        )}
                    </div>
                `
                : ''
        }

        ${
            slot.description
                ? `
                    <div class="details-text">
                        ${escapeHtml(
                            slot.description
                        )}
                    </div>
                `
                : ''
        }

        <div
            class="service-details"
        >
            <div
                class="details-text"
            >
                Свободный слот
            </div>
        </div>

        <button
            class="btn btn-primary"
            type="button"
        >
            Записаться
        </button>
    `;


    const button =
        card.querySelector(
            'button'
        );


    button.addEventListener(
        'click',
        async (event) => {
            event.stopPropagation();

            await bookSlot(
                slot
            );
        }
    );


    card.addEventListener(
        'click',
        (event) => {
            if (
                event.target.closest(
                    'button'
                )
            ) {
                return;
            }

            card
                .querySelector(
                    '.service-details'
                )
                ?.classList
                .toggle('expanded');
        }
    );


    return card;
}


async function bookSlot(
    slot
) {
    const userId =
        getTelegramUserId();


    if (!userId) {
        showTelegramPopup(
            'Откройте приложение через Telegram.'
        );

        return;
    }


    if (
        slot.status !==
        'Свободен'
    ) {
        showTelegramPopup(
            'Этот слот уже недоступен.'
        );

        await renderSearchResults();

        return;
    }


    try {
        hapticImpact('medium');


        const booking =
            await createBooking(
                userId,
                slot.slot_id
            );


        setSelectedSlot(
            slot
        );


        fillSuccessScreen(
            booking?.slot ||
            slot
        );


        navigate(
            'screen-model-success'
        );

    } catch (error) {
        console.error(
            'Booking error:',
            error
        );

        showTelegramPopup(
            error.message ||
            'Не удалось отправить заявку.'
        );
    }
}


function fillSuccessScreen(
    slot
) {
    const {
        date,
        time
    } =
        formatDateTime(
            slot.date_time
        );


    const serviceName =
        slot?.services?.name ||
        state.selectedServiceName ||
        'Услуга';


    const nameElement =
        document.getElementById(
            'succ-val-name'
        );

    const dateElement =
        document.getElementById(
            'succ-val-date'
        );

    const timeElement =
        document.getElementById(
            'succ-val-time'
        );

    const addressElement =
        document.getElementById(
            'succ-val-address'
        );


    if (nameElement) {
        nameElement.textContent =
            serviceName;
    }


    if (dateElement) {
        dateElement.textContent =
            date;
    }


    if (timeElement) {
        timeElement.textContent =
            time;
    }


    if (addressElement) {
        addressElement.textContent =
            slot.address ||
            'Адрес не указан';
    }
}


export function initModelSearch() {
    if (initialized) {
        return;
    }

    initialized = true;


    document.addEventListener(
        'bb:navigation',
        async (event) => {
            if (
                event.detail?.screenId ===
                'screen-model-search'
            ) {
                await loadSearchServices();
            }
        }
    );


    document.addEventListener(
        'bb:item-selected',
        async (event) => {
            if (
                event.detail?.elementId ===
                'selected-city'
            ) {
                setSelectedCity(
                    event.detail.value
                );

                await renderSearchResults();
            }
        }
    );


    loadSearchServices();
}