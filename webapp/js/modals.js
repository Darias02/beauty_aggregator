let activeModal = null;


export function initModals() {
    document.addEventListener(
        'keydown',
        (event) => {
            if (
                event.key === 'Escape' &&
                activeModal
            ) {
                closeModal();
            }
        }
    );
}


export function openModal({
    title,
    message = '',
    confirmText = 'Подтвердить',
    cancelText = 'Отмена',
    onConfirm = null,
    onCancel = null
}) {
    closeModal();


    const overlay =
        document.createElement('div');

    overlay.className =
        'modal-overlay';


    const box =
        document.createElement('div');

    box.className =
        'modal-box';


    const titleElement =
        document.createElement('div');

    titleElement.className =
        'modal-title';

    titleElement.textContent =
        title || '';


    box.appendChild(
        titleElement
    );


    if (message) {
        const messageElement =
            document.createElement('div');

        messageElement.className =
            'details-text';

        messageElement.style.marginBottom =
            '20px';

        messageElement.textContent =
            message;

        box.appendChild(
            messageElement
        );
    }


    const buttons =
        document.createElement('div');

    buttons.className =
        'modal-buttons';


    const cancelButton =
        document.createElement('button');

    cancelButton.className =
        'modal-btn';

    cancelButton.textContent =
        cancelText;


    const confirmButton =
        document.createElement('button');

    confirmButton.className =
        'modal-btn';

    confirmButton.textContent =
        confirmText;


    cancelButton.addEventListener(
        'click',
        () => {
            const callback =
                onCancel;

            closeModal();

            if (callback) {
                callback();
            }
        }
    );


    confirmButton.addEventListener(
        'click',
        async () => {
            const callback =
                onConfirm;

            closeModal();

            if (!callback) {
                return;
            }

            try {
                await callback();
            } catch (error) {
                console.error(
                    'Modal confirmation error:',
                    error
                );
            }
        }
    );


    buttons.appendChild(
        cancelButton
    );

    buttons.appendChild(
        confirmButton
    );

    box.appendChild(buttons);


    overlay.appendChild(box);

    document.body.appendChild(
        overlay
    );


    activeModal = overlay;


    requestAnimationFrame(() => {
        overlay.classList.add('active');
    });


    overlay.addEventListener(
        'click',
        (event) => {
            if (
                event.target === overlay
            ) {
                closeModal();
            }
        }
    );


    return {
        close: closeModal
    };
}


export function openConfirmModal({
    title = 'Подтвердите действие',
    message = '',
    confirmText = 'Подтвердить',
    cancelText = 'Отмена',
    onConfirm = null,
    onCancel = null
} = {}) {
    return openModal({
        title,
        message,
        confirmText,
        cancelText,
        onConfirm,
        onCancel
    });
}


export function openCancelBookingModal(
    onConfirm
) {
    return openConfirmModal({
        title: 'Отменить запись?',
        message:
            'Вы действительно хотите отменить эту запись?',
        confirmText: 'Отменить',
        cancelText: 'Назад',
        onConfirm
    });
}


export function openRejectBookingModal(
    onConfirm
) {
    return openConfirmModal({
        title: 'Отклонить заявку?',
        message:
            'После отклонения модель получит уведомление.',
        confirmText: 'Отклонить',
        cancelText: 'Назад',
        onConfirm
    });
}


export function closeModal() {
    if (!activeModal) {
        return;
    }


    const modal =
        activeModal;

    activeModal = null;


    modal.classList.remove('active');


    setTimeout(() => {
        modal.remove();
    }, 300);
}


export function isModalOpen() {
    return Boolean(activeModal);
}