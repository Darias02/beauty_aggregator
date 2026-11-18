import { attachSlotPhotos } from './slot-photos.js';
import { outlineIcon } from './icons.js';
import { hapticImpact } from '../telegram.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatDateTime(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return { date: String(value || ''), time: '' };
    }

    return {
        date: date.toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        }),
        time: date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
        })
    };
}

function getSlot(record) {
    return record?.slot || record?.slots || record;
}

function getServiceName(record) {
    const slot = getSlot(record);
    return slot?.services?.name || record?.services?.name || 'Услуга';
}


function renderDetail(kind, text, role) {
    if (!text) return '';
    const content = escapeHtml(text);
    if (role !== 'master') return `<div class="details-text">${content}</div>`;
    return `<div class="details-text record-detail">${outlineIcon(kind)}<span>${content}</span></div>`;
}

export function createRecordCard({
    record,
    role,
    onCancel = null,
    onDelete = null,
    onApprove = null,
    onReject = null,
    onContact = null
}) {
    const card = document.createElement('div');
    card.className = `service-card record-card${role === 'master' ? ' master-record-card' : ''}`;

    const slot = getSlot(record);
    const { date, time } = formatDateTime(slot?.date_time);
    const status = record?.status || 'Статус не указан';

    card.innerHTML = `
        <div class="service-header">
            <div class="service-left">
                <div class="record-main-info">
                    <div class="service-title">${escapeHtml(getServiceName(record))}</div>
                    <div class="service-time">${escapeHtml(date)} · ${escapeHtml(time)}</div>
                </div>
            </div>
        </div>

        <div class="service-status">${role === 'master' ? escapeHtml(status) : `статус: ${escapeHtml(status)}`}</div>

        ${renderDetail('city', slot?.city ? `Город: ${slot.city}` : '', role)}
        ${renderDetail('address', slot?.address ? `Адрес: ${slot.address}` : '', role)}
        ${renderDetail('description', slot?.description, role)}

        <div class="btn-action-group"></div>
    `;

    if (slot?.slot_id) attachSlotPhotos(card, slot.slot_id, { manage: role === 'master' });
    const actionGroup = card.querySelector('.btn-action-group');

    if (role === 'model') {
        if (typeof onCancel === 'function' && ['Активна', 'Ожидает подтверждения мастера'].includes(status)) {
            const button = document.createElement('button');
            button.className = 'btn-reject record-cancel';
            button.type = 'button';
            button.textContent = 'Отменить';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                hapticImpact('light');
                onCancel(record);
            });
            actionGroup.appendChild(button);
        }

        if (typeof onContact === 'function' && status === 'Активна') {
            const button = document.createElement('button');
            button.className = 'btn-approve record-contact';
            button.type = 'button';
            button.textContent = 'Связаться с мастером';
            button.addEventListener('click', () => onContact(record));
            actionGroup.appendChild(button);
        }
    }

    if (role === 'master') {
        if (typeof onApprove === 'function' && status === 'Ожидает подтверждения мастера') {
            const button = document.createElement('button');
            button.className = 'btn-approve';
            button.type = 'button';
            button.textContent = 'Подтвердить';
            button.addEventListener('click', async () => {
                if (button.disabled) return;
                const buttons = actionGroup.querySelectorAll('button');
                buttons.forEach((action) => { action.disabled = true; });
                try {
                    await onApprove(record);
                } finally {
                    buttons.forEach((action) => { action.disabled = false; });
                }
            });
            actionGroup.appendChild(button);
        }

        if (typeof onReject === 'function' && status === 'Ожидает подтверждения мастера') {
            const button = document.createElement('button');
            button.className = 'btn-reject';
            button.type = 'button';
            button.textContent = 'Отклонить';
            button.addEventListener('click', () => onReject(record));
            actionGroup.appendChild(button);
        }

        if (typeof onContact === 'function' && status === 'Активна') {
            const button = document.createElement('button');
            button.className = 'btn-approve record-contact';
            button.type = 'button';
            button.textContent = 'Связаться с моделью';
            button.addEventListener('click', () => onContact(record));
            actionGroup.appendChild(button);
        }

        if (typeof onDelete === 'function') {
            const button = document.createElement('button');
            button.className = 'btn-reject';
            button.type = 'button';
            button.textContent = 'Удалить слот';
            button.addEventListener('click', () => onDelete(record));
            actionGroup.appendChild(button);
        }

        if (typeof onCancel === 'function') {
            const button = document.createElement('button');
            button.className = 'btn-reject';
            button.type = 'button';
            button.textContent = 'Отменить слот';
            button.addEventListener('click', () => onCancel(record));
            actionGroup.appendChild(button);
        }
    }

    return card;
}