import {
    getMasterSlots
} from '../../data/slots.js';

import {
    getMasterBookings
} from '../../data/bookings.js';

import {
    createRecordCard
} from '../../components/record-card.js';

import {
    showSkeleton
} from '../../components/skeleton.js';

import {
    state,
    setMasterRecordsMode
} from '../../state.js';

import {
    getTelegramUserId,
    hapticImpact,
    showTelegramPopup
} from '../../telegram.js';


let initialized = false;

let slots = [];
let bookings = [];


const ACTIVE_SLOT_STATUSES = new Set([
    'Свободен',
    'Ожидает подтверждения',
    'Занят'
]);


export async function loadMasterRecords() {
    const container =
        document.getElementById(
            'master-records-list'
        );

    if (!container) {
        return;
    }


    const masterId =
        getTelegramUserId();


    if (!masterId) {
        showSkeleton(
            container,
            'Откройте приложение через Telegram'
        );

        return;
    }


    showSkeleton(
        container,
        'Загружаем слоты...'
    );


    try {
        const [
            loadedSlots,
            loadedBookings
        ] = await Promise.all([
            getMasterSlots(masterId),
            getMasterBookings(masterId)
        ]);


        slots =
            loadedSlots || [];

        bookings =
            loadedBookings || [];


        renderRecords();

    } catch (error) {
        console.error(
            'Master records loading error:',
            error
        );

        showSkeleton(
            container,
            'Не удалось загрузить слоты'
        );
    }
}


function renderTabs() {
    const panel =
        document.querySelector(
            '#screen-master-records .records-top-panel'
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
                state.masterRecordsMode === 'active'
                    ? 'active'
                    : ''
            }"
            data-mode="active"
        >
            Активные
        </div>

        <div
            class="tab-full ${
                state.masterRecordsMode === 'archive'
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

                        setMasterRecordsMode(
                            tab.dataset.mode
                        );

                        renderRecords();
                    }
                );
            }
        );
}


function getFilteredSlots() {
    if (
        state.masterRecordsMode ===
        'archive'
    ) {
        return slots.filter(
            (slot) =>
                !ACTIVE_SLOT_STATUSES.has(
                    slot.status
                )
        );
    }


    return slots.filter(
        (slot) =>
            ACTIVE_SLOT_STATUSES.has(
                slot.status
            )
    );
}


function getBookingForSlot(
    slotId
) {
    return bookings.find(
        (booking) =>
            booking.slot_id ===
            slotId
    );
}


function createMasterRecord(
    slot
) {
    const booking =
        getBookingForSlot(
            slot.slot_id
        );


    if (!booking) {
        return {
            ...slot,
            slots: slot
        };
    }


    return {
        ...booking,

        slot: slot,
        slots: slot,

        status:
            booking.status ||
            slot.status
    };
}


function renderRecords() {
    const container =
        document.getElementById(
            'master-records-list'
        );


    if (!container) {
        return;
    }


    renderTabs();


    const filteredSlots =
        getFilteredSlots();


    container.innerHTML = '';


    if (!filteredSlots.length) {
        showSkeleton(
            container,
            state.masterRecordsMode === 'active'
                ? 'Активных слотов пока нет'
                : 'Архив пока пуст'
        );

        return;
    }


    filteredSlots.forEach(
        (slot) => {
            const record =
                createMasterRecord(
                    slot
                );


            const booking =
                getBookingForSlot(
                    slot.slot_id
                );


            const card =
                createRecordCard({
                    record,
                    role: 'master',

                    onContact:
                        booking
                            ? handleContactModel
                            : null
                });


            container.appendChild(
                card
            );
        }
    );
}


function handleContactModel(
    record
) {
    const userId =
        record?.user_id;


    if (!userId) {
        showTelegramPopup(
            'Контакт модели пока недоступен.'
        );

        return;
    }


    hapticImpact('light');


    const telegramUrl =
        `tg://user?id=${userId}`;


    const tg =
        window.Telegram?.WebApp;


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


export function initMasterRecords() {
    if (initialized) {
        return;
    }

    initialized = true;


    document.addEventListener(
        'bb:navigation',
        async (event) => {
            if (
                event.detail?.screenId ===
                'screen-master-records'
            ) {
                await loadMasterRecords();
            }
        }
    );


    loadMasterRecords();
}