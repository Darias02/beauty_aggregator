"""In-memory API. No credentials, database clients or network calls."""
import copy
import base64

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=")

SERVICE = dict(service_id=1, name='Маникюр', duration='60 мин', description='Тестовая услуга')
SLOT = dict(slot_id=11, master_id=202, service_id=1, status='Свободен',
            date_time='2099-12-20T12:00:00Z', city='Москва', address='Тестовый адрес',
            description='Только mock', services=SERVICE)


class MockAPI:
    def __init__(self):
        self.calls = []
        self.next_slot_id = 12
        self.next_booking_id = 21
        self.slots = [copy.deepcopy(SLOT)]
        self.bookings = []
        self.user = dict(user_id=101, name='Модель mock')
        self.master = dict(master_id=202, name='Мастер mock', address='Тестовый адрес', avatar_url=None)
        self.failure = None
        self.failures = {}
        self.services = [copy.deepcopy(SERVICE)]

    def booking(self):
        return dict(booking_id=max([20] + [b['booking_id'] for b in self.bookings]) + 1,
                    slot_id=self.slots[0]['slot_id'], user_id=101,
                    status='Ожидает подтверждения мастера', reason=None,
                    slots=copy.deepcopy(self.slots[0]))

    def pending(self):
        self.bookings = [self.booking()]
        self.slots[0]['status'] = 'Ожидает подтверждения'

    def respond(self, endpoint, body):
        self.calls.append((endpoint, body))
        action = body.get('action')
        if endpoint == 'catalog':
            return {action: {'services': self.services,
                             'counts': {str(service['service_id']): sum(s['status'] == 'Свободен' and s['service_id'] == service['service_id'] for s in self.slots) for service in self.services},
                             'cities': sorted({s['city'] for s in self.slots if s['status'] == 'Свободен' and s.get('city')})}[action]}
        if endpoint in ('user-profile', 'master-profile', 'master-avatar'):
            profile = self.user if endpoint == 'user-profile' else self.master
            profile.update(body.get('profile', {}))
            if endpoint == 'master-avatar':
                profile['avatar_url'] = 'data:image/png;base64,' + base64.b64encode(PNG).decode()
            return {'profile': profile.copy()}
        if endpoint == 'slots-read':
            if action == 'slot':
                return {'slot': next((s for s in self.slots if s['slot_id'] == body.get('slot_id')), None)}
            return {'slots': self.slots if action == 'master' else [s for s in self.slots if s['status'] == 'Свободен' and
                    (not body.get('service_id') or s['service_id'] == body['service_id']) and
                    (not body.get('city') or s['city'] == body['city'])]}
        if endpoint == 'bookings-read':
            if action == 'booking':
                return {'booking': next((b for b in self.bookings if b['booking_id'] == body.get('booking_id')), None)}
            rows = [] if body.get('before') else sorted(self.bookings, key=lambda b: b['booking_id'], reverse=True)
            return {'bookings': rows, 'next_cursor': rows[-1]['booking_id'] if rows else None}
        if endpoint == 'booking-create':
            slot = next(s for s in self.slots if s['slot_id'] == body['slot_id'])
            assert slot['status'] == 'Свободен', 'Slot unavailable'
            booking = dict(booking_id=self.next_booking_id,
                           slot_id=slot['slot_id'], user_id=101,
                           status='Ожидает подтверждения мастера', reason=None,
                           slots=copy.deepcopy(slot))
            self.next_booking_id += 1
            self.bookings.append(booking)
            slot['status'] = 'Ожидает подтверждения'
            return {'booking': booking, 'replayed': False}
        if endpoint == 'bookings-write':
            b = next(b for b in self.bookings if b['booking_id'] == body['booking_id'])
            slot = next(s for s in self.slots if s['slot_id'] == b['slot_id'])
            b['status'] = {'confirm': 'Активна', 'reject': 'Отменена мастером', 'cancel': 'Отменена моделью'}[action]
            b['reason'] = body.get('reason')
            slot['status'] = 'Занят' if action == 'confirm' else 'Свободен'
            return {'booking': b.copy(), 'replayed': False}
        if endpoint == 'slots-write':
            if action == 'create':
                slot = {**copy.deepcopy(SLOT), **{k: v for k, v in body.items() if k not in ('action', 'init_data')}}
                slot['slot_id'] = self.next_slot_id
                self.next_slot_id += 1
                slot['services'] = copy.deepcopy(next(s for s in self.services if s['service_id'] == slot['service_id']))
                self.slots.append(slot)
                return {'slot': slot}
            slot = next(s for s in self.slots if s['slot_id'] == body['slot_id'])
            booking = next((b for b in reversed(self.bookings) if b['slot_id'] == slot['slot_id'] and
                            b['status'] in ('Ожидает подтверждения мастера', 'Активна')), None)
            if action == 'cancel' and booking:
                booking.update(status='Отменена мастером', reason='plans')
                slot['status'] = 'Отменен'
                return {'deleted': False, 'booking': booking.copy()}
            assert action == 'delete' and slot['status'] == 'Свободен'
            self.slots.remove(slot)
            return {'deleted': True}
        if endpoint in ('notify-user', 'notify-master'):
            return {'mock_only': True}
        raise AssertionError(f'Unmocked API endpoint: {endpoint}')
