let activeModal = null;

export function initModals() {
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && activeModal) closeModal();
    });
}

export function openChoiceModal({
    title,
    message = '',
    choices = [],
    onSelect = null,
    cancelText = 'Назад'
} = {}) {
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';

    const titleElement = document.createElement('div');
    titleElement.className = 'modal-title';
    titleElement.textContent = title || '';
    box.appendChild(titleElement);

    if (message) {
        const messageElement = document.createElement('div');
        messageElement.className = 'details-text';
        messageElement.textContent = message;
        box.appendChild(messageElement);
    }

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons modal-buttons-column';

    choices.forEach((choice) => {
        const button = document.createElement('button');
        button.className = choice.primary ? 'modal-btn modal-btn-primary' : 'modal-btn';
        button.textContent = choice.text;

        button.addEventListener('click', async () => {
            const callback = onSelect;
            closeModal();
            await callback?.(choice.value);
        });

        buttons.appendChild(button);
    });

    const cancelButton = document.createElement('button');
    cancelButton.className = 'modal-btn';
    cancelButton.textContent = cancelText;
    cancelButton.addEventListener('click', closeModal);
    buttons.appendChild(cancelButton);

    box.appendChild(buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    activeModal = overlay;

    requestAnimationFrame(() => overlay.classList.add('active'));

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeModal();
    });

    return { close: closeModal };
}

export function openConfirmModal({
    title = 'Подтвердите действие',
    message = '',
    confirmText = 'Подтвердить',
    cancelText = 'Отмена',
    onConfirm = null
} = {}) {
    return openChoiceModal({
        title,
        message,
        choices: [{ text: confirmText, value: true, primary: true }],
        onSelect: onConfirm,
        cancelText
    });
}

export function openCancelBookingModal(onSelectReason) {
    return openChoiceModal({
        title: 'Отменить запись?',
        message: 'Укажите причину отмены.',
        choices: [
            { text: 'Не подходит время', value: 'time' },
            { text: 'Другая причина', value: 'other' }
        ],
        onSelect: onSelectReason
    });
}

export function openRejectBookingModal(onSelectReason) {
    return openChoiceModal({
        title: 'Отклонить заявку?',
        message: 'Укажите причину.',
        choices: [
            { text: 'Не подходит модель', value: 'model' },
            { text: 'Изменились планы', value: 'plans', primary: true }
        ],
        onSelect: onSelectReason
    });
}

export function closeModal() {
    if (!activeModal) return;

    const modal = activeModal;
    activeModal = null;
    modal.classList.remove('active');

    setTimeout(() => modal.remove(), 300);
}