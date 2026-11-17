-- TEST DATA ONLY. Opt-in after migrations on a separate empty test database.
-- No fixed IDs: keep identity sequences aligned for subsequent server inserts.
begin;
insert into public.services (name, description) values
    ('[ТЕСТ BB-70] Маникюр', 'Тестовая услуга для проверки каталога и создания слотов.'),
    ('[ТЕСТ BB-70] Стрижка', 'Тестовая услуга для проверки бронирований.'),
    ('[ТЕСТ BB-70] Макияж', 'Тестовая услуга; не является реальным предложением.');
commit;
