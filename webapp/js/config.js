export const APP_CONFIG = {
    name: 'BB',

    supabase: {
        url: 'https://bxzwfidujuejmrbqjmgo.supabase.co',
        key: 'sb_publishable_eQsfW9mYbM1i3Vhwr7h8ig_jM29E24C'
    },

    cities: [
        'Москва',
        'Санкт-Петербург'
    ],

    roles: {
        MODEL: 'model',
        MASTER: 'master'
    },

    statuses: {
        SLOT_FREE: 'Свободен',
        SLOT_WAITING: 'Ожидает подтверждения',
        SLOT_BUSY: 'Занят',
        SLOT_CANCELLED: 'Отменен',

        BOOKING_PENDING: 'Ожидает подтверждения мастера',
        BOOKING_ACTIVE: 'Активна',
        BOOKING_REJECTED: 'Отменена мастером'
    }
};