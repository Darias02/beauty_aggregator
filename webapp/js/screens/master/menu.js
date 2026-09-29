import { getMasterBookings, confirmBooking, rejectBooking } from '../../data/bookings.js';
import { createRecordCard } from '../../components/record-card.js';
import { getTelegramUserId, showTelegramPopup } from '../../telegram.js';
import { openRejectBookingModal } from '../../modals.js';

let initialized = false;

export async function loadMasterMenu() {
    const container = document.getElementById('master-empty-state');
    if (!container) return;

    const userId = getTelegramUserId();
    if (!userId) return;

    try {
        const bookings = await getMasterBookings(userId);
        const pending = bookings.filter(
            (booking) => booking.status === 'Ожидает подтверждения мастера'
        );

        let list = document.getElementById('master-applications-list');

        if (!list) {
            list = document.createElement('div');
            list.id = 'master-applications-list';
            list.className = 'records-list';
            container.insertAdjacentElement('afterend', list);
        }

        list.innerHTML = '';

        if (!pending.length) {
            container.innerHTML = 'На данный момент<br>нет активных заявок';
            return;
        }

        container.innerHTML = '';

        pending.forEach((booking) => {
            list.appendChild(createRecordCard({
                record: booking,
                role: 'master',
                onApprove: async (record) => {
                    try {
                        await confirmBooking(record.booking_id);
                        showTelegramPopup('Запись подтверждена.');
                        await loadMasterMenu();
                    } catch (error) {
                        showTelegramPopup(error.message || 'Не удалось подтвердить запись.');
                    }
                },
                onReject: (record) => {
                    openRejectBookingModal(async (reason) => {
                        try {
                            await rejectBooking(record.booking_id, reason);
                            showTelegramPopup('Заявка обработана.');
                            await loadMasterMenu();
                        } catch (error) {
                            showTelegramPopup(error.message || 'Не удалось обработать заявку.');
                        }
                    });
                }
            }));
        }
    } catch (error) {
        console.error('Master menu loading error:', error);
        container.innerHTML = 'Не удалось загрузить<br>заявки';
    }
}

export function initMasterMenu() {
    if (initialized) return;
    initialized = true;

    document.addEventListener('bb:navigation', async (event) => {
        if (event.detail?.screenId === 'screen-master-menu') {
            await loadMasterMenu();
        }
    });

    loadMasterMenu();
}