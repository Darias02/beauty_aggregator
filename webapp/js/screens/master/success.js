import {
    navigate
} from '../../router.js';


let initialized = false;


export function initMasterSuccess() {
    if (initialized) {
        return;
    }

    initialized = true;


    const button =
        document.querySelector(
            '#screen-master-success button'
        );


    if (!button) {
        return;
    }


    button.addEventListener(
        'click',
        () => {
            navigate(
                'screen-master-menu'
            );
        }
    );
}