import {
    navigate
} from '../../router.js';


let initialized = false;


export function showModelSuccess({
    serviceName = '',
    date = '',
    time = '',
    address = ''
} = {}) {
    const nameElement =
        document.getElementById(
            'succ-val-name'
        );

    const dateElement =
        document.getElementById(
            'succ-val-date'
        );

    const timeElement =
        document.getElementById(
            'succ-val-time'
        );

    const addressElement =
        document.getElementById(
            'succ-val-address'
        );


    if (nameElement) {
        nameElement.textContent =
            serviceName;
    }


    if (dateElement) {
        dateElement.textContent =
            date;
    }


    if (timeElement) {
        timeElement.textContent =
            time;
    }


    if (addressElement) {
        addressElement.textContent =
            address;
    }
}


export function initModelSuccess() {
    if (initialized) {
        return;
    }

    initialized = true;


    const homeButton =
        document.querySelector(
            '#screen-model-success button'
        );


    if (homeButton) {
        homeButton.onclick = () => {
            navigate(
                'screen-model-menu'
            );
        };
    }
}