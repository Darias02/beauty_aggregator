# BB-74 local checks

Из корня репозитория, Python 3.11+:

```sh
python3 -m unittest discover -s tests/bb74 -v
python3 tools/release/preflight.py edge
```

Unit tests используют только фиктивные файлы, значения окружения и локальные исходники.
Историческая база `9fbbc0b` имела Edge blockers. В BB-76 они исправлены: preflight должен возвращать PASS. Регрессия отдельно вносит missing lock/unpinned import и требует отказ.

Для отдельной репетиции настоящего PostgreSQL установленные binaries передаются явно:

```sh
python3 tools/release/pg_rehearsal.py --pg-bin /opt/homebrew/opt/postgresql@18/bin
```

Скрипт не использует существующие кластеры, credentials или SQL файлы.
Пакетный restore проверяет файлы, PostgreSQL rehearsal проверяет фиктивную БД.
Они не заменяют проверку реального scope будущего backup.

[Процедура](../../docs/bb74-release-runbook.md),
[checklist](../../docs/bb74-release-checklist.md).
