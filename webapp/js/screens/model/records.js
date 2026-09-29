import { getUserBookings, cancelBooking } from '../../data/bookings.js';
import { createRecordCard } from '../../components/record-card.js';
import { showSkeleton } from '../../components/skeleton.js';
import { state, setModelRecordsMode } from '../../state.js';
import { getTelegramUserId, hapticImpact, showTelegramPopup } from '../../telegram.js';
import { openCancelBookingModal } from '../../modals.js';

let initialized = false;
let records = [];

const ACTIVE = new Set(['Ожидает подтверждения мастера', 'Активна']);

export async function loadModelRecords() {
    const container = document.getElementById('model-records-list');
    if (!container) return;

    const userId = getTelegramUserId();

    if (!userId) {
        showSkeleton(container, 'Откройте приложение через Telegram');
        return;
    }

    showSkeleton(container, 'Загружаем записи...');

    try {
        records = await getUserBookings(userId);
        renderRecords();
    } catch (error) {
        console.error('Model records loading error:', error);
        showSkeleton(container, 'Не удалось загрузить записи');
    }
}

function renderTabs() {
    const panel = document.querySelector('#screen-model-records .records-top-panel');
    if (!panel) return;

    let tabs = panel.querySelector('.tabs-container-full');

    if (!tabs) {
        tabs = document.createElement('div');
        tabs.className = 'tabs-container-full';
        panel.appendChild(tabs);
    }

    tabs.innerHTML = `
        <div class="tab-full ${state.modelRecordsMode === 'active' ? 'active' : ''}" data-mode="active">Активные</div>
        <div class="tab-full ${state.modelRecordsMode === 'archive' ? 'active' : ''}" data-mode="archive">Архив</div>
    `;

    tabs.querySelectorAll('.tab-full').forEach((tab) => {
        tab.addEventListener('click', () => {
            hapticImpact('light');
            setModelRecordsMode(tab.dataset.mode);
            renderRecords();
        });
    });
}

function renderRecords() {
    const container = document.getElementById('model-records-list');
    if (!container) return;

    renderTabs();

    const filtered = state.modelRecordsMode === 'archive'
        ? records.filter((record) => !ACTIVE.has(record.status))
        : records.filter((record) => ACTIVE.has(record.status));

    container.innerHTML = '';

    if (!filtered.length) {
        showSkeleton(
            container,
            state.modelRecordsMode === 'active'
                ? 'Активных записей пока нет'
                : 'Архив пока пуст'
        );
        return;
    }

    filtered.forEach((record) => {
        container.appendChild(createRecordCard({
            record,
            role: 'model',
            onCancel: ACTIVE.has(record.status) ? handleCancel : null,
            onContact: record.status === 'Активна' ? handleContactMaster : null
        }));
    });
}

function handleCancel(record) {
    openCancelBookingModal(async (reason) => {
        try {
            await cancelBooking(record.booking_id, reason);
            showTelegramPopup('Запись отменена.');
            await loadModelRecords();
        } catch (error) {
            showTelegramPopup(error.message || 'Не удалось отменить запись.');
        }
    });
}

function handleContactMaster(record) {
    const masterId = record?.slots?.master_id || record?.slot?.master_id;

    if (!masterId) {
        showTelegramPopup('Контакт мастера пока недоступен.');
        return;
    }

    hapticImpact('light');
    window.Telegram?.WebApp?.openTelegramLink?.(`tg://user?id=${masterId}`);
}

export function initModelRecords() {
    if (initialized) return;
    initialized = true;

    document.addEventListener('bb:navigation', async (event) => {
        if (event.detail?.screenId === 'screen-model-records') {
            await loadModelRecords();
        }
    });

    loadModelRecords();
}