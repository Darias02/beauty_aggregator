import { getMasterSlots, cancelSlot, deleteSlot } from '../../data/slots.js';
import { getMasterBookings, confirmBooking, rejectBooking } from '../../data/bookings.js';
import { createRecordCard } from '../../components/record-card.js';
import { showSkeleton } from '../../components/skeleton.js';
import { state, setMasterRecordsMode } from '../../state.js';
import { getTelegramUserId, hapticImpact, showTelegramPopup } from '../../telegram.js';
import { openRejectBookingModal, openConfirmModal } from '../../modals.js';

let initialized = false;
let slots = [];
let bookings = [];

const ACTIVE = new Set(['Свободен', 'Ожидает подтверждения', 'Занят']);

function isPast(slot) {
    return slot?.date_time && new Date(slot.date_time) <= new Date();
}

export async function loadMasterRecords() {
    const container = document.getElementById('master-records-list');
    if (!container) return;

    const masterId = getTelegramUserId();

    if (!masterId) {
        showSkeleton(container, 'Откройте приложение через Telegram');
        return;
    }

    showSkeleton(container, 'Загружаем слоты...');

    try {
        [slots, bookings] = await Promise.all([
            getMasterSlots(masterId),
            getMasterBookings(masterId)
        ]);

        renderRecords();
    } catch (error) {
        console.error('Master records loading error:', error);
        showSkeleton(container, 'Не удалось загрузить слоты');
    }
}

function getBooking(slotId) {
    return bookings.find((booking) => booking.slot_id === slotId);
}

function renderTabs() {
    const panel = document.querySelector('#screen-master-records .records-top-panel');
    if (!panel) return;

    let tabs = panel.querySelector('.tabs-container-full');

    if (!tabs) {
        tabs = document.createElement('div');
        tabs.className = 'tabs-container-full';
        panel.appendChild(tabs);
    }

    tabs.innerHTML = `
        <div class="tab-full ${state.masterRecordsMode === 'active' ? 'active' : ''}" data-mode="active">Активные</div>
        <div class="tab-full ${state.masterRecordsMode === 'archive' ? 'active' : ''}" data-mode="archive">Архив</div>
    `;

    tabs.querySelectorAll('.tab-full').forEach((tab) => {
        tab.addEventListener('click', () => {
            hapticImpact('light');
            setMasterRecordsMode(tab.dataset.mode);
            renderRecords();
        });
    });
}

function renderRecords() {
    const container = document.getElementById('master-records-list');
    if (!container) return;

    renderTabs();

    const filtered = state.masterRecordsMode === 'archive'
        ? slots.filter((slot) => !ACTIVE.has(slot.status) || isPast(slot))
        : slots.filter((slot) => ACTIVE.has(slot.status) && !isPast(slot));

    container.innerHTML = '';

    if (!filtered.length) {
        showSkeleton(
            container,
            state.masterRecordsMode === 'active'
                ? 'Активных слотов пока нет'
                : 'Архив пока пуст'
        );
        return;
    }

    filtered.forEach((slot) => {
        const booking = getBooking(slot.slot_id);
        const record = booking
            ? { ...booking, slot, slots: slot }
            : { ...slot, slots: slot };

        container.appendChild(createRecordCard({
            record,
            role: 'master',
            onApprove: booking?.status === 'Ожидает подтверждения мастера'
                ? handleApprove
                : null,
            onReject: booking?.status === 'Ожидает подтверждения мастера'
                ? handleReject
                : null,
            onContact: booking?.status === 'Активна'
                ? handleContactModel
                : null,
            onDelete: !booking && slot.status === 'Свободен'
                ? handleDelete
                : null,
            onCancel: booking && ['Ожидает подтверждения мастера', 'Активна'].includes(booking.status)
                ? handleCancelSlot
                : null
        }));
    });
}

async function handleApprove(record) {
    try {
        await confirmBooking(record.booking_id);
        showTelegramPopup('Запись подтверждена.');
        await loadMasterRecords();
    } catch (error) {
        showTelegramPopup(error.message || 'Не удалось подтвердить запись.');
    }
}

function handleReject(record) {
    openRejectBookingModal(async (reason) => {
        try {
            await rejectBooking(record.booking_id, reason);
            showTelegramPopup('Заявка обработана.');
            await loadMasterRecords();
        } catch (error) {
            showTelegramPopup(error.message || 'Не удалось обработать заявку.');
        }
    });
}

function handleContactModel(record) {
    const userId = record?.user_id;

    if (!userId) {
        showTelegramPopup('Контакт модели пока недоступен.');
        return;
    }

    window.Telegram?.WebApp?.openTelegramLink?.(`tg://user?id=${userId}`);
}

function handleDelete(record) {
    openConfirmModal({
        title: 'Удалить слот?',
        message: 'Слот свободен, поэтому его можно удалить.',
        confirmText: 'Удалить',
        onConfirm: async () => {
            try {
                await deleteSlot(record.slot_id, getTelegramUserId());
                showTelegramPopup('Слот удалён.');
                await loadMasterRecords();
            } catch (error) {
                showTelegramPopup(error.message || 'Не удалось удалить слот.');
            }
        }
    });
}

function handleCancelSlot(record) {
    openRejectBookingModal(async (reason) => {
        try {
            if (reason === 'model') {
                await rejectBooking(record.booking_id, 'model');
            } else {
                const result = await cancelSlot(
                    record.slot_id,
                    getTelegramUserId()
                );

                if (!result.deleted) {
                    const { sendNotification } = await import('../../data/notifications.js');
                    await sendNotification('notify-user', {
                        type: 'slot_cancelled',
                        booking_id: record.booking_id
                    });
                }
            }

            showTelegramPopup(
                reason === 'model'
                    ? 'Слот снова доступен, но эта модель не увидит его.'
                    : 'Слот отменён.'
            );

            await loadMasterRecords();
        } catch (error) {
            showTelegramPopup(error.message || 'Не удалось отменить слот.');
        }
    });
}

export function initMasterRecords() {
    if (initialized) return;
    initialized = true;

    document.addEventListener('bb:navigation', async (event) => {
        if (event.detail?.screenId === 'screen-master-records') {
            await loadMasterRecords();
        }
    });

    loadMasterRecords();
}