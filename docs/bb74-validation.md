# BB-74: локальная проверка

Проверено 2026-11-08 в Codex worktree `bb-74-release-preparation`.
База `9fbbc0be2e1090ba7f23ef263532164cce16aa74` подтверждена также через
`git ls-remote origin refs/heads/bb-73-existing-db-migration` перед коммитом.
GitHub API вернул `visibility=private` для `Darias02/beauty_aggregator_dev`.

| Проверка | Результат |
| --- | --- |
| `python3 -m unittest discover -s tests/bb74 -v` | 22 PASS |
| `python3 tools/release/pg_rehearsal.py --pg-bin /opt/homebrew/opt/postgresql@18/bin` | PASS, fresh socket-only PostgreSQL 18.4, fictional dump/restore |
| `deno test --cached-only --frozen --allow-read=vendor/magick.wasm tests/` в master-avatar | 42 PASS, 0 failed, реальные WASM decode и entrypoint, mocked network |
| `python3 tools/release/preflight.py edge` | Exit 1, 7 ожидаемых сообщений о блокерах исходного комплекта |
| `git diff --check` | PASS |
| `supabase --version`, `supabase functions deploy --help` | CLI 3.0.0, прочитаны только version/help |

В тестах проверены corruption, missing components, extra files, symlink, traversal,
повторная/вложенная цель restore, duplicate Auth users, duplicate/missing Storage objects,
counts, malformed secrets, redaction, frontend credential leakage и WASM mismatch.
Локально устранены недостающая проверка bot `SUPABASE_KEY` и возможность вложенной
цели файлового restore. Изменения ограничены новыми файлами BB-74.

Блокеры preflight: у `bookings-write` нет lockfile; у каждой notify-функции нет
`deno.json`, `deno.lock` и закреплённого точного npm import. Их исходники не менялись.
Завершение BB-73 требуется для production audit, адаптированного SQL, maintenance gate,
production artifact, списка writers и фактического транспорта бота.

Остаются непроверенными managed Supabase restore, реальный scope backup, bundle/static
assets внутри Edge Runtime, hosted cold start, конфигурация Vercel и совместимость с
production. PostgreSQL 18 rehearsal не доказывает совместимость production PostgreSQL.
CLI version/help создали в этом worktree `supabase/.temp/cli-latest`; этот единственный
временный файл удалён, в коммит не входит. Никакие реальные backup, deploy, SQL,
webhook изменения, облачные проекты или merge не выполнялись.
