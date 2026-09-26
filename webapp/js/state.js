import {
    APP_CONFIG
} from './config.js';


const initialState = {
    currentRole:
        APP_CONFIG.roles.MODEL,

    currentScreen:
        'screen-model-menu',

    user: null,

    selectedServiceId:
        null,

    selectedServiceName:
        null,

    selectedCity:
        null,

    selectedSlot:
        null,

    selectedBooking:
        null,

    selectedDate:
        null,

    modelRecordsMode:
        'active',

    masterRecordsMode:
        'active'
};


export const state = {
    ...initialState
};


export function setRole(
    role
) {
    if (
        role !==
            APP_CONFIG.roles.MODEL &&
        role !==
            APP_CONFIG.roles.MASTER
    ) {
        return;
    }


    state.currentRole =
        role;


    document.dispatchEvent(
        new CustomEvent(
            'bb:role-changed',
            {
                detail: {
                    role
                }
            }
        )
    );
}


export function setScreen(
    screenId
) {
    state.currentScreen =
        screenId;
}


export function setUser(
    user
) {
    state.user =
        user;
}


export function setSelectedService(
    service
) {
    if (!service) {
        state.selectedServiceId =
            null;

        state.selectedServiceName =
            null;

        return;
    }


    state.selectedServiceId =
        service.service_id ??
        service.id ??
        null;


    state.selectedServiceName =
        service.name ??
        null;
}


export function setSelectedServiceId(
    serviceId
) {
    state.selectedServiceId =
        serviceId;
}


export function setSelectedServiceName(
    serviceName
) {
    state.selectedServiceName =
        serviceName;
}


export function setSelectedCity(
    city
) {
    state.selectedCity =
        city || null;
}


export function setSelectedSlot(
    slot
) {
    state.selectedSlot =
        slot || null;
}


export function setSelectedBooking(
    booking
) {
    state.selectedBooking =
        booking || null;
}


export function setSelectedDate(
    date
) {
    state.selectedDate =
        date || null;
}


export function setModelRecordsMode(
    mode
) {
    state.modelRecordsMode =
        mode;
}


export function setMasterRecordsMode(
    mode
) {
    state.masterRecordsMode =
        mode;
}


export function resetSearch() {
    state.selectedServiceId =
        null;

    state.selectedServiceName =
        null;

    state.selectedCity =
        null;

    state.selectedSlot =
        null;
}


export function resetSlotCreation() {
    state.selectedDate =
        null;
}


export function resetTransientState() {
    state.selectedSlot =
        null;

    state.selectedBooking =
        null;

    state.selectedDate =
        null;
}


export function getState() {
    return {
        ...state
    };
}