import {
    hapticImpact
} from '../telegram.js';


function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}


function formatDateTime(
    value
) {
    if (!value) {
        return {
            date: '',
            time: ''
        };
    }


    const date =
        new Date(value);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return {
            date: String(value),
            time: ''
        };
    }


    return {
        date: date.toLocaleDateString(
            'ru-RU',
            {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }
        ),

        time: date.toLocaleTimeString(
            'ru-RU',
            {
                hour: '2-digit',
                minute: '2-digit'
            }
        )
    };
}


function getStatusText(
    record
) {
    return (
        record?.status ||
        record?.slots?.status ||
        'Статус не указан'
    );
}


function getServiceName(
    record
) {
    return (
        record?.slot?.services?.name ||
        record?.slots?.services?.name ||
        record?.services?.name ||
        record?.service_name ||
        'Услуга'
    );
}


function getSlot(record) {
    return (
        record?.slot ||
        record?.slots ||
        record
    );
}


export function createRecordCard({
    record,
    role = 'model',
    onCancel = null,
    onApprove = null,
    onReject = null,
    onContact = null
}) {
    const card =
        document.createElement('div');

    card.className =
        'service-card record-card';


    const slot =
        getSlot(record);


    const {
        date,
        time
    } = formatDateTime(
        slot?.date_time
    );


    const serviceName =
        getServiceName(
            record
        );


    const status =
        getStatusText(
            record
        );


    const city =
        slot?.city || '';


    const address =
        slot?.address || '';


    const description =
        slot?.description || '';


    card.innerHTML = `
        <div class="service-header">

            <div class="service-left">

                <div class="service-icon">
                    BB
                </div>

                <div>

                    <div class="service-title">
                        ${escapeHtml(serviceName)}
                    </div>

                    <div class="service-time">
                        ${escapeHtml(date)}
                        ${time
                            ? ` · ${escapeHtml(time)}`
                            : ''
                        }
                    </div>

                </div>

            </div>

        </div>

        <div class="service-status">
            ${escapeHtml(status)}
        </div>

        ${
            city
                ? `
                    <div class="details-text">
                        Город: ${escapeHtml(city)}
                    </div>
                `
                : ''
        }

        ${
            address
                ? `
                    <div class="details-text">
                        Адрес: ${escapeHtml(address)}
                    </div>
                `
                : ''
        }

        ${
            description
                ? `
                    <div class="details-text">
                        ${escapeHtml(description)}
                    </div>
                `
                : ''
        }

        <div class="btn-action-group"></div>
    `;


    const actionGroup =
        card.querySelector(
            '.btn-action-group'
        );


    if (role === 'model') {
        if (
            typeof onCancel ===
            'function' &&
            (
                status === 'Активна' ||
                status ===
                    'Ожидает подтверждения мастера'
            )
        ) {
            const cancelButton =
                document.createElement(
                    'button'
                );

            cancelButton.className =
                'btn-reject record-cancel';

            cancelButton.type =
                'button';

            cancelButton.textContent =
                'Отменить';


            cancelButton.addEventListener(
                'click',
                (event) => {
                    event.stopPropagation();
                    hapticImpact('light');
                    onCancel(record);
                }
            );


            card.appendChild(
                cancelButton
            );
        }


        if (
            typeof onContact ===
            'function' &&
            status === 'Активна'
        ) {
            const contactButton =
                document.createElement(
                    'button'
                );

            contactButton.className =
                'btn-approve';

            contactButton.type =
                'button';

            contactButton.textContent =
                'Связаться с мастером';


            contactButton.addEventListener(
                'click',
                () => {
                    hapticImpact('light');
                    onContact(record);
                }
            );


            actionGroup.appendChild(
                contactButton
            );
        }
    }


    if (role === 'master') {
        if (
            typeof onApprove ===
                'function' &&
            status ===
                'Ожидает подтверждения мастера'
        ) {
            const approveButton =
                document.createElement(
                    'button'
                );

            approveButton.className =
                'btn-approve';

            approveButton.type =
                'button';

            approveButton.textContent =
                'Подтвердить';


            approveButton.addEventListener(
                'click',
                (event) => {
                    event.stopPropagation();
                    hapticImpact('medium');
                    onApprove(record);
                }
            );


            actionGroup.appendChild(
                approveButton
            );
        }


        if (
            typeof onReject ===
                'function' &&
            status ===
                'Ожидает подтверждения мастера'
        ) {
            const rejectButton =
                document.createElement(
                    'button'
                );

            rejectButton.className =
                'btn-reject';

            rejectButton.type =
                'button';

            rejectButton.textContent =
                'Отклонить';


            rejectButton.addEventListener(
                'click',
                (event) => {
                    event.stopPropagation();
                    hapticImpact('light');
                    onReject(record);
                }
            );


            actionGroup.appendChild(
                rejectButton
            );
        }


        if (
            typeof onContact ===
                'function' &&
            (
                status === 'Активна' ||
                status === 'Занят'
            )
        ) {
            const contactButton =
                document.createElement(
                    'button'
                );

            contactButton.className =
                'btn-approve';

            contactButton.type =
                'button';

            contactButton.textContent =
                'Связаться с моделью';


            contactButton.addEventListener(
                'click',
                () => {
                    hapticImpact('light');
                    onContact(record);
                }
            );


            actionGroup.appendChild(
                contactButton
            );
        }
    }


    return card;
}


export function renderRecordCards({
    container,
    records,
    role,
    onCancel,
    onApprove,
    onReject,
    onContact
}) {
    if (!container) {
        return;
    }


    container.innerHTML = '';


    if (!records?.length) {
        const empty =
            document.createElement(
                'div'
            );

        empty.className =
            'skeleton-card service-card';


        empty.innerHTML = `
            <div class="skeleton-text">
                На данный момент<br>
                нет записей
            </div>
        `;


        container.appendChild(
            empty
        );

        return;
    }


    records.forEach(
        (record) => {
            const card =
                createRecordCard({
                    record,
                    role,
                    onCancel,
                    onApprove,
                    onReject,
                    onContact
                });


            container.appendChild(card);
        }
    );
}