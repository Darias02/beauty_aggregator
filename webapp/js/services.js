import {
    getServices,
    getAvailableSlots,
    getAvailableSlotCounts,
    createBooking
} from './api.js';


function getTelegramUserId() {
    return window.Telegram?.WebApp?.initDataUnsafe?.user?.id ?? null;
}


function getSelectedCity() {
    return document
        .getElementById('selected-city')
        ?.textContent
        ?.trim() || null;
}


export function getSkeleton(text) {
    return `
        <div class="service-card skeleton-card">
            <div class="skeleton-text">
                ${text}
            </div>
        </div>
    `;
}


function createServiceIcon(iconUrl) {
    const icon = document.createElement('div');

    icon.className = 'service-icon';

    if (iconUrl) {
        icon.style.backgroundImage = `url("${iconUrl}")`;
        icon.style.backgroundSize = 'cover';
        icon.style.backgroundPosition = 'center';
        icon.style.color = 'transparent';
        icon.style.border = 'none';
    } else {
        icon.textContent = 'услуга';
    }

    return icon;
}


function createServiceCard(service, hasSlots) {
    const card = document.createElement('div');

    card.className = 'service-card';

    if (!hasSlots) {
        card.style.opacity = '0.5';
        card.style.filter = 'grayscale(100%)';
    }

    const header = document.createElement('div');
    header.className = 'service-header';

    const left = document.createElement('div');
    left.className = 'service-left';

    const icon = createServiceIcon(service.icon_url);

    const title = document.createElement('div');
    title.className = 'service-title';
    title.textContent = service.name;

    left.append(icon, title);

    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.style.width = '150px';
    button.style.marginTop = '-10px';
    button.textContent = 'Выбрать';

    header.append(left);
    card.append(header);

    const buttonWrapper = document.createElement('div');
    buttonWrapper.style.display = 'flex';
    buttonWrapper.style.justifyContent = 'flex-end';
    buttonWrapper.appendChild(button);

    card.appendChild(buttonWrapper);

    button.addEventListener('click', () => {
        window.navigate('screen-model-search');

        window.renderSearchResults(service.service_id);
    });

    return card;
}


export async function renderRealServices() {
    const menu = document.getElementById('model-menu-services');

    if (!menu) {
        return;
    }

    try {
        const services = await getServices();
        const slotCounts = await getAvailableSlotCounts();

        menu.innerHTML = '';

        if (!services.length) {
            menu.innerHTML = getSkeleton(
                'Здесь пока нет доступных услуг'
            );

            return;
        }

        const tags = document.getElementById('service-tags');

        if (tags) {
            tags.innerHTML = '';

            services.forEach((service, index) => {
                const tag = document.createElement('div');

                tag.className = 'tag';

                if (index === 0) {
                    tag.classList.add('active');
                }

                tag.textContent = service.name;

                tag.addEventListener('click', () => {
                    document
                        .querySelectorAll('.tag')
                        .forEach(item => item.classList.remove('active'));

                    tag.classList.add('active');

                    renderSearchResults(service.service_id);
                });

                tags.appendChild(tag);
            });
        }

        services.forEach(service => {
            const hasSlots =
                (slotCounts[service.service_id] || 0) > 0;

            const card = createServiceCard(
                service,
                hasSlots
            );

            menu.appendChild(card);
        });

        await renderSearchResults(
            services[0].service_id
        );

    } catch (error) {
        console.error('Ошибка загрузки услуг:', error);

        menu.innerHTML = getSkeleton(
            'Не удалось загрузить услуги'
        );
    }
}


export async function renderSearchResults(serviceId) {
    const container =
        document.getElementById('model-search-results');

    if (!container) {
        return;
    }

    container.innerHTML = getSkeleton(
        'Загрузка свободных слотов...'
    );

    try {
        const city = getSelectedCity();

        const slots = await getAvailableSlots(
            serviceId,
            city
        );

        container.innerHTML = '';

        if (!slots.length) {
            container.innerHTML = getSkeleton(
                'Для этой услуги пока нет свободных слотов'
            );

            return;
        }

        slots.forEach(slot => {
            const card =
                createSlotCard(slot);

            container.appendChild(card);
        });

    } catch (error) {
        console.error(
            'Ошибка загрузки слотов:',
            error
        );

        container.innerHTML = getSkeleton(
            'Не удалось загрузить свободные слоты'
        );
    }
}


function createSlotCard(slot) {
    const card = document.createElement('div');

    card.className = 'service-card';

    const header = document.createElement('div');
    header.className = 'service-header';

    const left = document.createElement('div');
    left.className = 'service-left';

    const icon =
        createServiceIcon(
            slot.services?.icon_url
        );

    const title = document.createElement('div');
    title.className = 'service-title';
    title.textContent =
        slot.service_name || 'Услуга';

    left.append(icon, title);

    const time =
        document.createElement('div');

    time.className = 'service-time';

    const date =
        slot.date_time
            ? new Date(slot.date_time)
            : null;

    time.textContent =
        date && !Number.isNaN(date.getTime())
            ? date.toLocaleString(
                'ru-RU',
                {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                }
            )
            : 'Дата и время';

    header.append(left, time);

    const detailsButton =
        document.createElement('button');

    detailsButton.className =
        'btn btn-outline btn-small';

    detailsButton.style.marginBottom =
        '15px';

    detailsButton.textContent =
        'Подробнее';

    const details =
        document.createElement('div');

    details.className =
        'service-details';

    const address =
        document.createElement('div');

    address.className =
        'details-text address';

    address.textContent =
        slot.address || slot.city || '';

    const description =
        document.createElement('div');

    description.className =
        'details-text description';

    description.textContent =
        slot.description || '';

    details.append(address, description);

    detailsButton.addEventListener(
        'click',
        () => {
            details.classList.toggle('expanded');

            detailsButton.textContent =
                details.classList.contains('expanded')
                    ? 'Меньше'
                    : 'Подробнее';
        }
    );

    const bookingButton =
        document.createElement('button');

    bookingButton.className =
        'btn btn-primary';

    bookingButton.textContent =
        'Записаться';

    bookingButton.addEventListener(
        'click',
        () => bookRealSlot(slot)
    );

    card.append(
        header,
        detailsButton,
        details,
        bookingButton
    );

    return card;
}


export async function bookRealSlot(slot) {
    const userId = getTelegramUserId();

    if (!userId) {
        alert(
            'Откройте приложение через Telegram.'
        );

        return;
    }

    try {
        await createBooking(
            userId,
            slot.slot_id
        );

        const date =
            new Date(slot.date_time);

        document.getElementById(
            'succ-val-name'
        ).textContent =
            slot.service_name || 'Услуга';

        document.getElementById(
            'succ-val-date'
        ).textContent =
            date.toLocaleDateString(
                'ru-RU',
                {
                    day: '2-digit',
                    month: '2-digit'
                }
            );

        document.getElementById(
            'succ-val-time'
        ).textContent =
            date.toLocaleTimeString(
                'ru-RU',
                {
                    hour: '2-digit',
                    minute: '2-digit'
                }
            );

        document.getElementById(
            'succ-val-address'
        ).textContent =
            (slot.address ||
             slot.city ||
             'Адрес').split('(')[0];

        window.navigate(
            'screen-model-success'
        );

    } catch (error) {
        console.error(
            'Ошибка создания записи:',
            error
        );

        alert(
            'Не удалось отправить заявку.'
        );
    }
}


window.getSkeleton = getSkeleton;
window.renderRealServices = renderRealServices;
window.renderSearchResults = renderSearchResults;
window.bookRealSlot = bookRealSlot;