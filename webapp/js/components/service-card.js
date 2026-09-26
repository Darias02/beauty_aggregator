import {
    setSelectedService
} from '../state.js';

import {
    hapticImpact
} from '../telegram.js';


function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}


export function createServiceCard({
    service,
    availableCount = 0,
    onSelect = null
}) {
    const card =
        document.createElement('div');

    card.className =
        'service-card';


    const serviceName =
        service?.name ||
        'Услуга';


    const iconUrl =
        service?.icon_url ||
        '';


    const countText =
        availableCount === 0
            ? 'Нет свободных слотов'
            : availableCount === 1
                ? '1 свободный слот'
                : `${availableCount} свободных слотов`;


    card.innerHTML = `
        <div class="service-header">

            <div class="service-left">

                <div
                    class="service-icon"
                    ${iconUrl
                        ? `style="background-image:url('${escapeHtml(iconUrl)}'); background-size:cover; background-position:center;"`
                        : ''
                    }
                >
                    ${iconUrl
                        ? ''
                        : 'BB'
                    }
                </div>

                <div>
                    <div class="service-title">
                        ${escapeHtml(serviceName)}
                    </div>

                    <div class="service-time">
                        ${escapeHtml(
                            service?.duration ||
                            ''
                        )}
                    </div>
                </div>

            </div>

        </div>

        <div class="service-status">
            ${escapeHtml(countText)}
        </div>

        <button
            class="btn btn-primary btn-small"
            type="button"
        >
            Выбрать
        </button>

        <div class="service-details">
            <div class="details-text">
                ${escapeHtml(
                    service?.description ||
                    'Доступные слоты этой услуги.'
                )}
            </div>
        </div>
    `;


    const button =
        card.querySelector(
            'button'
        );


    button.addEventListener(
        'click',
        (event) => {
            event.stopPropagation();

            hapticImpact('light');

            setSelectedService(
                service
            );


            if (typeof onSelect === 'function') {
                onSelect(service);
            }


            document.dispatchEvent(
                new CustomEvent(
                    'bb:service-selected',
                    {
                        detail: {
                            service
                        }
                    }
                )
            );
        }
    );


    card.addEventListener(
        'click',
        () => {
            const details =
                card.querySelector(
                    '.service-details'
                );

            if (details) {
                details.classList.toggle(
                    'expanded'
                );
            }
        }
    );


    return card;
}


export function renderServiceCards({
    container,
    services,
    counts = {},
    onSelect = null
}) {
    if (!container) {
        return;
    }


    container.innerHTML = '';


    (services || []).forEach(
        (service) => {
            const serviceId =
                service.service_id;


            const card =
                createServiceCard({
                    service,
                    availableCount:
                        counts[serviceId] || 0,
                    onSelect
                });


            container.appendChild(card);
        }
    );
}