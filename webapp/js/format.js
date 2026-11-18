const russianPlural = new Intl.PluralRules('ru');
const slotForms = {
    one: 'свободный слот',
    few: 'свободных слота',
    many: 'свободных слотов',
    other: 'свободных слотов'
};

export function formatAvailableSlots(count) {
    if (count === 0) return 'Нет свободных слотов';
    return `${count} ${slotForms[russianPlural.select(count)]}`;
}
