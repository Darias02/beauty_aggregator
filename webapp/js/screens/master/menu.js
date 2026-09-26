import {
    getMasterBookings,
    confirmBooking,
    rejectBooking
} from '../../data/bookings.js';

import {
    createRecordCard
} from '../../components/record-card.js';

import {
    showSkeleton
} from '../../components/skeleton.js';

import {
    getTelegramUserId,
    hapticImpact,
    showTelegramPopup
} from '../../telegram.js';

import {
    openRejectBookingModal
} from '../../modals.js';


let initialized = false;
let bookings = [];


const PENDING_STATUS =
    'Ожидает подтверждения мастера';


export async function loadMasterMenu() {
    const container =
        document.getElementById(
            'master-empty-state'
        );


    if (!container) {
        return;
    }


    const userId =
        getTelegramUserId();


    if (!userId) {
        container.innerHTML = `
            Откройте приложение<br>
            через Telegram
        `;

        return;
    }


    container.innerHTML =
        'Загрузка...';


    try {
        bookings =
            await getMasterBookings(
                userId
            );


        renderApplications();

    } catch (error) {
        console.error(
            'Master menu loading error:',
            error
        );

        container.innerHTML = `
            Не удалось загрузить<br>
            заявки
        `;
    }
}


function getPendingBookings() {
    return bookings.filter(
        (booking) =>
            booking.status ===
            PENDING_STATUS
    );
}


function renderApplications() {
    const emptyState =
        document.getElementById(
            'master-empty-state'
        );


    const menu =
        document.getElementById(
            'screen-master-menu'
        );


    if (!menu) {
        return;
    }


    const pending =
        getPendingBookings();


    let list =
        document.getElementById(
            'master-applications-list'
        );


    if (!list) {
        list =
            document.createElement(
                'div'
            );

        list.id =
            'master-applications-list';

        list.className =
            'records-list';


        emptyState?.insertAdjacentElement(
            'afterend',
            list
        );
    }


    list.innerHTML = '';


    if (!pending.length) {
        emptyState.innerHTML =
            'На данный момент<br>нет активных заявок';

        return;
    }


    if (emptyState) {
        emptyState.innerHTML =
            '';
    }


    pending.forEach(
        (booking) => {
            const card =
                createRecordCard({
                    record: booking,
                    role: 'master',

                    onApprove:
                        handleApprove,

                    onReject:
                        handleReject
                });


            list.appendChild(card);
        }
    );
}


async function handleApprove(
    booking
) {
    if (!booking?.booking_id) {
        return;
    }


    try {
        hapticImpact('medium');


        await confirmBooking(
            booking.booking_id
        );


        showTelegramPopup(
            'Запись подтверждена.'
        );


        await loadMasterMenu();

    } catch (error) {
        console.error(
            'Confirm booking error:',
            error
        );

        showTelegramPopup(
            error.message ||
            'Не удалось подтвердить запись.'
        );
    }
}


function handleReject(
    booking
) {
    if (!booking?.booking_id) {
        return;
    }


    openRejectBookingModal(
        async () => {
            try {
                await rejectBooking(
                    booking.booking_id
                );


                showTelegramPopup(
                    'Заявка отклонена.'
                );


                await loadMasterMenu();

            } catch (error) {
                console.error(
                    'Reject booking error:',
                    error
                );

                showTelegramPopup(
                    error.message ||
                    'Не удалось отклонить заявку.'
                );
            }
        }
    );
}


export function initMasterMenu() {
    if (initialized) {
        return;
    }

    initialized = true;


    document.addEventListener(
        'bb:navigation',
        async (event) => {
            if (
                event.detail?.screenId ===
                'screen-master-menu'
            ) {
                await loadMasterMenu();
            }
        }
    );


    loadMasterMenu();
}