import {
    getUserBookings,
    cancelBooking
} from '../../data/bookings.js';

import {
    createRecordCard
} from '../../components/record-card.js';

import {
    showSkeleton
} from '../../components/skeleton.js';

import {
    state,
    setModelRecordsMode
} from '../../state.js';

import {
    getTelegramUserId,
    hapticImpact,
    showTelegramPopup
} from '../../telegram.js';

import {
    openCancelBookingModal
} from '../../modals.js';


let initialized = false;
let records = [];


const ACTIVE_STATUSES = new Set([
    'Ожидает подтверждения мастера',
    'Активна'
]);


const ARCHIVE_STATUSES = new Set([
    'Отменена мастером',
    'Отменена моделью',
    'Завершена',
    'Архив'
]);


export async function loadModelRecords() {
    const container =
        document.getElementById(
            'model-records-list'
        );

    if (!container) {
        return;
    }


    const userId =
        getTelegramUserId();


    if (!userId) {
        showSkeleton(
            container,
            'Откройте приложение через Telegram'
        );

        return;
    }


    showSkeleton(
        container,
        'Загружаем записи...'
    );


    try {
        records =
            await getUserBookings(
                userId
            );

        renderRecords();

    } catch (error) {
        console.error(
            'Model records loading error:',
            error
        );

        showSkeleton(
            container,
            'Не удалось загрузить записи'
        );
    }
}


function renderRecordsTabs() {
    const panel =
        document.querySelector(
            '#screen-model-records .records-top-panel'
        );


    if (!panel) {
        return;
    }


    let tabs =
        panel.querySelector(
            '.tabs-container-full'
        );


    if (!tabs) {
        tabs =
            document.createElement(
                'div'
            );

        tabs.className =
            'tabs-container-full';

        panel.appendChild(
            tabs
        );
    }


    tabs.innerHTML = `
        <div
            class="tab-full ${
                state.modelRecordsMode === 'active'
                    ? 'active'
                    : ''
            }"
            data-mode="active"
        >
            Активные
        </div>

        <div
            class="tab-full ${
                state.modelRecordsMode === 'archive'
                    ? 'active'
                    : ''
            }"
            data-mode="archive"
        >
            Архив
        </div>
    `;


    tabs
        .querySelectorAll(
            '.tab-full'
        )
        .forEach(
            (tab) => {
                tab.addEventListener(
                    'click',
                    () => {
                        hapticImpact('light');

                        setModelRecordsMode(
                            tab.dataset.mode
                        );

                        renderRecords();
                    }
                );
            }
        );
}


function getFilteredRecords() {
    if (
        state.modelRecordsMode ===
        'archive'
    ) {
        return records.filter(
            (record) =>
                !ACTIVE_STATUSES.has(
                    record.status
                )
        );
    }


    return records.filter(
        (record) =>
            ACTIVE_STATUSES.has(
                record.status
            )
    );
}


function renderRecords() {
    const container =
        document.getElementById(
            'model-records-list'
        );


    if (!container) {
        return;
    }


    renderRecordsTabs();


    const filteredRecords =
        getFilteredRecords();


    container.innerHTML = '';


    if (!filteredRecords.length) {
        showSkeleton(
            container,
            state.modelRecordsMode ===
                'active'
                ? 'Активных записей пока нет'
                : 'Архив пока пуст'
        );

        return;
    }


    filteredRecords.forEach(
        (record) => {
            const card =
                createRecordCard({
                    record,
                    role: 'model',

                    onCancel:
                        record.status ===
                            'Ожидает подтверждения мастера' ||
                        record.status ===
                            'Активна'
                            ? handleCancel
                            : null,

                    onContact:
                        record.status ===
                        'Активна'
                            ? handleContactMaster
                            : null
                });


            container.appendChild(
                card
            );
        }
    );
}


async function handleCancel(
    record
) {
    const bookingId =
        record.booking_id;


    if (!bookingId) {
        return;
    }


    openCancelBookingModal(
        async () => {
            try {
                await cancelBooking(
                    bookingId
                );

                showTelegramPopup(
                    'Запись отменена.'
                );

                await loadModelRecords();

            } catch (error) {
                console.error(
                    'Cancel booking error:',
                    error
                );

                showTelegramPopup(
                    error.message ||
                    'Не удалось отменить запись.'
                );
            }
        }
    );
}


function handleContactMaster(
    record
) {
    const masterId =
        record?.slots?.master_id ||
        record?.slot?.master_id;


    if (!masterId) {
        showTelegramPopup(
            'Контакт мастера пока недоступен.'
        );

        return;
    }


    hapticImpact('light');


    const tg =
        window.Telegram?.WebApp;


    const telegramUrl =
        `tg://user?id=${masterId}`;


    if (
        tg &&
        typeof tg.openTelegramLink ===
            'function'
    ) {
        tg.openTelegramLink(
            telegramUrl
        );

        return;
    }


    window.location.href =
        telegramUrl;
}


export function initModelRecords() {
    if (initialized) {
        return;
    }

    initialized = true;


    document.addEventListener(
        'bb:navigation',
        async (event) => {
            if (
                event.detail?.screenId ===
                'screen-model-records'
            ) {
                await loadModelRecords();
            }
        }
    );


    loadModelRecords();
}