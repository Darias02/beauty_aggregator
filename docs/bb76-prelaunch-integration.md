# BB-76: итог локальной интеграции

Дата: 2026-11-13. Приватный `Darias02/beauty_aggregator_dev` подтверждён GitHub API.
Отдельный Codex worktree и ветка `bb-76-prelaunch-integration` созданы от BB-73.
Облачная Supabase, Telegram, Vercel, main и исходные ветки не изменялись.
Реальные credentials и пользовательские данные для тестов не использовались.

## Состав и конфликты

- BB-73 `8ee5adb57574e0922493c990dc2f288cb28bcfa5`: production builder, release gate,
  versioned assets, аудит существующей БД и защита истории, включая RESTRICT родителей.
- BB-74 `8e78c3d2d0d900996a50c3a6e4bf2db4bd4df8ed`: backup/preflight/rehearsal инструменты.
- BB-75 `ee5532e2a4d00561f7ac7ce97442927d42e80f2f`: UI и браузерные сценарии.

BB-74/75 имеют общего предка `9fbbc0be2e1090ba7f23ef263532164cce16aa74`.
Обе ветки объединены через merge, исходная история сохранена. Текстовых конфликтов нет.
Семантические расхождения тестов исправлены:

1. BB-74 больше не требует наличия исправленных blockers. Теперь требует чистый
   Edge preflight и отдельно проверяет отказ при удалённом lock и плавающем import.
2. Тест master-profile учитывает показ ошибки загрузки из BB-75 и проверяет,
   что сохранённое имя в backend не изменилось. Восстановление профиля тоже проверяется.
3. Тест безопасности mock-сервера различает source preview и настоящий production
   artifact. Production HTML сохраняет Telegram SDK, но тест перехватывает его без сети.

Production код UI сохранён из BB-75. Все те же сценарии теперь можно выполнить на
сборке BB-73 через `--production-artifact`. Файлы артефакта не переписываются тестом.
SDK/fonts заменяются только браузерными ответами, API полностью фиктивны,
любой неожиданный внешний запрос проваливает тест. Реальная подпись проверяется
отдельными Edge/HTTP тестами, browser mock не является доказательством Telegram identity.

## Исправления Edge

Deno 2.9.8 штатно сгенерировал отсутствовавшие lockfiles для bookings-write,
notify-user, notify-master. Notify используют import map с точным
`npm:@supabase/supabase-js@2.118.0`, как остальные API. Добавлены strict deno.json,
check/lint/test задачи. Notify-тест использует ту же закреплённую версию SDK.

`tools/release/check_edge.py` выполняет штатные задачи всех 12 функций без shell,
добавляет `--cached-only --frozen` к Deno check/test, проверяет неизменность lockfiles.
У legacy booking-create нет lint task: проверяются три production TS-файла напрямую.
Расширенный lint его старого Node test fixture выявляет require-await/prefer-const/
unused-variable замечания; этот fixture не входит в production lint. Они не подавлены
новыми исключениями. Остальные объявленные lint/check задачи проходят, включая fmt webhook.
Node для booking-create нужен в PATH; в этом проходе использован Node из установленного
Playwright. Runner ничего не устанавливает и не вызывает serve/deploy.

## Проверки

| Проверка | Итог |
| --- | --- |
| SQL BB-63/64/66/67/70/73 + package/production build | 164 passed, 5 subtests passed |
| BB-74 backup/preflight | 23 passed |
| Фиктивный PostgreSQL 18 dump/restore BB-74 | PASS |
| Все 12 Edge check/lint/test, frozen Deno, неизменность locks | PASS |
| Avatar WASM unit/entrypoint | 42 passed в полном Edge прогоне |
| Notify signed identity/freshness/ownership/delivery contract | PASS, только mocked delivery |
| Release gate + master records | 13 passed |
| Staging build isolation | 3 passed |
| BB-75 source UI | 34 passed |
| BB-75 production artifact UI, включая gate-before-API | 35 passed |
| PostgreSQL 18 restore с сохранением строгого preflight | 1 passed: ожидаемый отказ constraint drift |
| PostgreSQL 17 fictional dump → restore → preflight → 10 migrations | PASS |
| Offline `python3 tools/release/preflight.py edge` | PASS |
| `git diff --check` | PASS |

Chrome 157.0.8103.78, Playwright 1.64.1, Python 3.13.0, Node 24.22.1. Использованы мобильные viewport
320×568, 360×640, 390×844, 430×932. PNG/trace доступны в игнорируемом
`tests/bb75/artifacts/`, production-файлы имеют префикс `production-`.

В новой настоящей локальной Supabase `/private/tmp/bb72-local-supabase-1f70ey9f`
на VM bb72 выполнен existing-db rehearsal, PostgreSQL 17, Edge Runtime 1.77.9.
Проверены project labels/workdir/no-link и loopback-сеть `bb72-local-only`.
База создана без миграций/seed, затем synthetic fixture воспроизвёл аудированную форму.
BB-70 и `20260930_bb.sql` как миграции не применялись.

Строгий preflight прошёл и отверг column/index drift. Все десять выбранных файлов
применились, полные фиктивные строки и PNG-байты сохранились. Подтверждены четыре
RESTRICT FK, RLS/grants, запрет удаления родителей с историей. HTTP-проверки прошли:
каталог/профили, legacy city=NULL, создание, подтверждение, отклонение, отмена моделью
и мастером, ownership, replay, сохранение истории, один победитель конкурентного запроса.
Дополнительно прошли Auth-issued client denials, missing/forged initData восьми JSON API,
реальный Storage roundtrip JPEG/PNG/WebP, WASM cold initialization, corrupt/MIME/5MiB
limits, restrictive Storage policy даже при permissive allow. Внешние Telegram success
paths не вызывались. Notify проверены с перехваченными DB/Telegram fetch.

Отдельная PG17 репетиция восстановила фиктивный dump в другую временную БД и только
затем применила строгий preflight и десять SQL. Сверены core rows, sequences,
фиктивный Auth stand-in, ACL, RESTRICT и три restrictive Storage policies. Это не полный
restore managed Auth/Storage; их совместимость с реальным backup остаётся открытой.
PG18 dump также восстанавливается, но исходный preflight справедливо отвергает другой
каталог NOT NULL constraints. Проверку не ослабляли. Для реального restore нужна
совместимая PG17 среда, а не автоматический переход на PostgreSQL 18.

## Аудит, SQL-пакет и ограничения выпуска

Использован фактический приватный read-only аудит BB-73 от 13 ноября
и его свидетельства, которые не включены в публичный перенос.
Новых облачных запросов или изменений в BB-76 не выполнялось.
`scripts/prepare_existing_upgrade.py`, SQL preflight и новая миграция
`20261113135354_bb73_preserve_parent_history.sql` сохранены без изменения.
Проверены SHA-256 пакета, отсутствие baseline/seed и строгий порядок десяти SQL.
Исторические миграции не изменены. Права BB-01/03 сохранены.

Offline Edge preflight проходит. Это не полный go/no-go: реальные env scopes,
hosted bundle/static_files/cold start, Vercel cache headers, Telegram WebView,
доставка уведомлений, writers и старые клиенты ещё не подтверждены.
У notify нет гарантии exactly-once. Прямой privileged DELETE bookings остаётся
операторским риском; RESTRICT не защищает от владельца БД или отключения constraints.

Реальный backup запрещён текущим разрешением. Нужны отдельное согласование scope,
шифрования/recovery keys, RPO/RTO, release owner, ledger adoption и остановки writers.
Нельзя использовать `backup.py` как production collector: он принимает только
фиктивный bundle и проверяет локальный формат. Нужен согласованный полный снимок
БД и всех Storage bytes с независимыми inventory/counts/hashes и проверенным restore.
SQL backup не содержит Storage bytes. Состояние аудита не является согласованным backup.

[Итоговый checklist](bb76-release-checklist.md) содержит точный порядок выпуска.
Система не объявляется production-ready до реального восстановления и hosted Telegram E2E.

## Повторение

```sh
python3 tools/release/preflight.py edge
python3 tools/release/check_edge.py
python3 -m unittest discover -s tests/bb74 -v
python3 -m pytest tests/bb76 -q -p no:cacheprovider
python3 -m pytest tests/bb75 --production-artifact -q -p no:cacheprovider
python3 tests/bb76/rehearse_restored_upgrade.py /private/tmp/bb72-local-supabase-REPLACE
```

Последняя команда принимает только проверяемый BB72 localhost project и создаёт
две отдельные временные БД, которые удаляет после теста. Сначала подготовить новую
локальную среду по BB-73/72. Не передавать cloud URL, реальные SQL или credentials.
Для реальных managed HTTP фаз использовать BB-73 rehearsal, не stand-in restore.
В этом проходе source SHA main/BB-73/74/75 сверены через `git ls-remote` и совпали
с исходными. Push разрешён только в новую приватную `bb-76-prelaunch-integration`.
