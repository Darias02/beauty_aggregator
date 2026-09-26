import {
    setSelectedDate
} from '../state.js';

import {
    hapticImpact
} from '../telegram.js';


const MONTHS_RU = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь'
];


const WEEKDAYS_RU = [
    'Пн',
    'Вт',
    'Ср',
    'Чт',
    'Пт',
    'Сб',
    'Вс'
];


function startOfDay(date) {
    const result =
        new Date(date);

    result.setHours(
        0,
        0,
        0,
        0
    );

    return result;
}


function isSameDay(
    first,
    second
) {
    return (
        first.getFullYear() ===
            second.getFullYear() &&
        first.getMonth() ===
            second.getMonth() &&
        first.getDate() ===
            second.getDate()
    );
}


function getMonthStartOffset(
    year,
    month
) {
    const day =
        new Date(
            year,
            month,
            1
        ).getDay();

    return day === 0
        ? 6
        : day - 1;
}


export function renderCalendar({
    grid,
    header,
    initialDate = null,
    onSelect = null
}) {
    if (!grid || !header) {
        return;
    }


    const today =
        startOfDay(
            new Date()
        );


    const selectedDate =
        initialDate
            ? startOfDay(
                new Date(initialDate)
            )
            : null;


    const year =
        selectedDate?.getFullYear() ??
        today.getFullYear();


    const month =
        selectedDate?.getMonth() ??
        today.getMonth();


    grid.innerHTML =
        '';


    header.textContent =
        `${MONTHS_RU[month]} ${year}`;


    WEEKDAYS_RU.forEach(
        (weekday) => {
            const element =
                document.createElement(
                    'div'
                );

            element.className =
                'calendar-day-name';

            element.textContent =
                weekday;

            grid.appendChild(
                element
            );
        }
    );


    const emptyDays =
        getMonthStartOffset(
            year,
            month
        );


    for (
        let index = 0;
        index < emptyDays;
        index += 1
    ) {
        grid.appendChild(
            document.createElement(
                'div'
            )
        );
    }


    const daysInMonth =
        new Date(
            year,
            month + 1,
            0
        ).getDate();


    for (
        let dayNumber = 1;
        dayNumber <= daysInMonth;
        dayNumber += 1
    ) {
        const date =
            new Date(
                year,
                month,
                dayNumber
            );


        const element =
            document.createElement(
                'div'
            );


        element.className =
            'calendar-day';


        element.textContent =
            String(dayNumber);


        const isPast =
            date < today;


        if (isPast) {
            element.style.opacity =
                '0.3';

            element.style.pointerEvents =
                'none';
        }


        if (
            selectedDate &&
            isSameDay(
                date,
                selectedDate
            )
        ) {
            element.classList.add(
                'selected'
            );
        }


        if (!isPast) {
            element.addEventListener(
                'click',
                () => {
                    grid
                        .querySelectorAll(
                            '.calendar-day'
                        )
                        .forEach(
                            (dayElement) => {
                                dayElement.classList.remove(
                                    'selected'
                                );
                            }
                        );


                    element.classList.add(
                        'selected'
                    );


                    const selected =
                        new Date(
                            year,
                            month,
                            dayNumber
                        );


                    setSelectedDate(
                        selected
                    );


                    hapticImpact(
                        'light'
                    );


                    if (
                        typeof onSelect ===
                        'function'
                    ) {
                        onSelect(
                            selected
                        );
                    }
                }
            );
        }


        grid.appendChild(
            element
        );
    }
}


export function initCalendar({
    gridId = 'calendar-grid',
    headerId = 'calendar-header',
    initialDate = null,
    onSelect = null
} = {}) {
    const grid =
        document.getElementById(
            gridId
        );

    const header =
        document.getElementById(
            headerId
        );


    if (!grid || !header) {
        return null;
    }


    renderCalendar({
        grid,
        header,
        initialDate,
        onSelect
    });


    return {
        grid,
        header,
        render(
            date = null
        ) {
            renderCalendar({
                grid,
                header,
                initialDate: date,
                onSelect
            });
        }
    };
}