# BB-73 local history regression

Фактический аудит и новый existing-db маршрут:
`schema_fixture.json`.

Новые проверки после изменения FK:

```sh
python3 -m unittest discover -s tests/bb73 -p 'test_existing_package.py' -v
python3 -m pytest tests/bb73/test_parent_history.py tests/bb73/test_history.py tests/bb70 -q --tb=short -p no:cacheprovider --basetemp=/private/tmp/bb73-verified-upgrade-final
```

Для настоящей локальной Supabase сначала выполните
`python3 tests/bb73/rehearse_existing_supabase.py --prepare`.
Он создаёт НОВЫЙ временный каталог с пустым migration route и без seed; не очищает
существующий проект. Запустите только этот проект и functions serve по инструкции
BB-72 с network `bb72-local-only`, только start/functions serve, без reset. Затем выполните
`python3 tests/bb73/rehearse_existing_supabase.py /private/tmp/bb72-local-supabase-SUFFIX`.
Скрипт проверяет path/project ID/labels/loopback/no-link и отсутствие public.users.
Он воспроизводит форму production на fake rows и PNG, проверяет preflight drift,
применяет выбранные SQL локально и сравнивает полные строки/байты, FK/RLS и Edge flow.
Облачные URLs/DSNs/ключи, reset/push/repair/deploy он не принимает и не вызывает.
Файл `local-fixture.sql` из пакета никогда не применять к существующей БД.

Production-build и release gate проверяются отдельно по
[инструкции frontend](../../docs/production-frontend.md); SQL-регрессии ниже
не требуется повторять при изменении только сборщика/загрузчика.

These tests use fake rows and disposable Unix-socket PostgreSQL databases only.
They never load production DSNs or `.env`. The SQL patch is applied after all
historical migrations, including BB-70 only because these databases start empty.

```sh
python3 -m pytest tests/bb73 tests/bb64 tests/bb66 tests/bb67 -q --tb=short -p no:cacheprovider --basetemp=/private/tmp/bb73-history-final
python3 -m pytest tests/bb63 tests/bb70 -q --tb=short -p no:cacheprovider --basetemp=/private/tmp/bb73-base-final
```

The regression covers both RPC paths with cancelled, unknown and NULL history,
retry preservation, concurrent history insertion before the slot lock, FK insert
after deletion, repeated upgrade of populated tables, client ACL and suppressed
DELETE triggers. Existing suites cover creation, double booking, decisions,
cancellations and reverse lock ordering. BB-64 continues rejecting unknown booking
states before delegation, with BB64_INVALID_STATE instead of BB73_SLOT_HAS_HISTORY.

For a real local Supabase/HTTP check, use the guarded setup in
[BB-72](../bb72/README.md), then run `Probe.schema`, `auth_denials`, `bookings`,
`rls` and `concurrency` against the new temporary project. Do not reuse seeded
booking fixtures or a cloud project. No reset is needed on a fresh project.

On 2026-11-08, the initial regression reproduced successful deletion of a slot
with cancelled history before the patch. The final result is recorded in
`schema_fixture.json`.
