import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const recordsSource = await readFile(new URL('../../webapp/js/screens/master/records.js', import.meta.url), 'utf8');
const cardSource = await readFile(new URL('../../webapp/js/components/record-card.js', import.meta.url), 'utf8');

class Element {
    children = [];
    listeners = {};
    _html = '';
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html; }
    appendChild(child) { this.children.push(child); }
    querySelector() { return this.group ??= new Element(); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
}

async function screen(slot, bookings, mode = 'active') {
    const container = new Element();
    let confirmation;
    const deleted = [];
    const context = vm.createContext({
        console,
        document: {
            getElementById: () => container,
            querySelector: () => null,
            createElement: () => new Element(),
        },
        fetch: () => { throw new Error('Network is forbidden in BB-69 tests'); },
    });
    const modules = {
        '../../data/slots.js': {
            getMasterSlots: async () => [slot], cancelSlot: async () => {},
            deleteSlot: async (...args) => deleted.push(args),
        },
        '../../data/bookings.js': {
            getMasterBookings: async () => bookings,
            confirmBooking: async () => {}, rejectBooking: async () => {},
        },
        '../../components/skeleton.js': { showSkeleton: () => {} },
        '../../state.js': { state: { masterRecordsMode: mode }, setMasterRecordsMode: () => {} },
        '../../telegram.js': {
            getTelegramUserId: () => 123, hapticImpact: () => {}, showTelegramPopup: () => {},
        },
        '../../modals.js': {
            openRejectBookingModal: () => {}, openConfirmModal: (options) => { confirmation = options; },
        },
    };
    const card = new vm.SourceTextModule(cardSource, { context });
    const telegram = modules['../../telegram.js'];
    const mock = (values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
    await card.link(() => mock(telegram));
    const records = new vm.SourceTextModule(recordsSource, { context });
    await records.link((specifier) => specifier === '../../components/record-card.js'
        ? card : mock(modules[specifier]));
    await records.evaluate();
    await records.namespace.loadMasterRecords();
    return { container, deleted, confirmation: () => confirmation };
}

const slot = { slot_id: 7, status: 'Свободен', date_time: '2099-01-01T12:00:00Z' };
const history = (status, reason = null) => ({ booking_id: 11, slot_id: 7, user_id: 456, status, reason });
const buttons = (card) => card.group.children.map((button) => button.textContent);

for (const [name, bookings] of [
    ['without history', []],
    ['after model cancellation', [history('Отменена моделью', 'time')]],
    ['after master rejection of model', [history('Отменена мастером', 'model')]],
]) {
    test(`free slot ${name}: show free status and delete the slot`, async () => {
        const before = JSON.stringify(bookings);
        const result = await screen(slot, bookings);
        const [card] = result.container.children;
        assert.match(card.innerHTML, /статус: Свободен/);
        assert.deepEqual(buttons(card), ['Удалить слот']);
        card.group.children[0].listeners.click();
        await result.confirmation().onConfirm();
        assert.deepEqual(result.deleted, [[7, 123]]);
        assert.equal(JSON.stringify(bookings), before);
    });
}

for (const [status, slotStatus, expected] of [
    ['Ожидает подтверждения мастера', 'Ожидает подтверждения', ['Подтвердить', 'Отклонить', 'Отменить слот']],
    ['Активна', 'Занят', ['Связаться с моделью', 'Отменить слот']],
]) {
    for (const currentFirst of [false, true]) {
        test(`${status}: current booking wins over cancelled history, currentFirst=${currentFirst}`, async () => {
            const current = { ...history(status), booking_id: 12 };
            const cancelled = history('Отменена мастером', 'model');
            const bookings = currentFirst ? [current, cancelled] : [cancelled, current];
            const before = JSON.stringify(bookings);
            const result = await screen({ ...slot, status: slotStatus }, bookings);
            const [card] = result.container.children;
            assert.ok(card.innerHTML.includes(`статус: ${status}`));
            assert.deepEqual(buttons(card), expected);
            assert.equal(JSON.stringify(bookings), before);
        });
    }
}

test('archive retains cancelled booking status and has no slot actions', async () => {
    const result = await screen({ ...slot, status: 'Отменен' }, [history('Отменена мастером', 'time')], 'archive');
    const [card] = result.container.children;
    assert.match(card.innerHTML, /статус: Отменена мастером/);
    assert.deepEqual(buttons(card), []);
});

test('past free slot stays in archive and does not display historical applicant', async () => {
    const past = { ...slot, date_time: '2000-01-01T12:00:00Z' };
    assert.equal((await screen(past, [])).container.children.length, 0);
    const result = await screen(past, [history('Отменена моделью', 'other')], 'archive');
    assert.match(result.container.children[0].innerHTML, /статус: Свободен/);
});
