# BB-74: подготовка выпуска

Статус на 2026-11-08: подготовка выполнена локально, выпуск заблокирован до результатов BB-73.
База ветки: `9fbbc0be2e1090ba7f23ef263532164cce16aa74`, сохранённая
`origin/bb-73-existing-db-migration`. GitHub API подтвердил private visibility.
Незакоммиченные изменения BB-73 не включены. Миграции, frontend, bot и Edge исходники не менялись.

## Архитектура и границы

| Компонент | Сохранённая реализация | Значение для выпуска |
| --- | --- | --- |
| Frontend | Статический `webapp/`, ES modules, Telegram Mini App, `scripts/build_staging_frontend.py` | Vercel должен публиковать только собранный каталог. Production сборка и cache/version зависят от BB-73. |
| API | 12 Edge Functions в `supabase/functions`, общий Telegram HMAC в `_shared/telegram.ts` | `verify_jwt=false` требует проверки initData или webhook secret внутри handler. |
| Данные | PostgreSQL migrations, server RPC, RLS, ограничение live bookings | Только адаптированный SQL BB-73 после сравнения реальной схемы. Baseline не применять поверх существующей БД. |
| Файлы | Storage, avatar API, vendored ImageMagick WASM | Сохранять байты отдельно от SQL, bucket policy и ссылки на аватары. |
| Bot | `run.py` → aiogram polling; `database/client.py` → Supabase API | Python использует `SUPABASE_KEY`, не Edge имя ключа. Загрузка dotenv происходит после импорта start handler, URL может остаться default. Проверить в BB-73. |
| Webhook | `telegram-webhook`, receipts с состояниями отправки | Выбрать один транспорт. Не запускать polling одновременно с webhook. |
| Notifications | `notify-master`, `notify-user`, `_shared/notifications.ts` | Внешнюю отправку отключить в репетиции. БД restore не отменяет отправленные сообщения. |
| Hosting | URL Vercel в bot fallback и frontend config, `vercel.json` отсутствует в базе | Реальные build settings, alias, rollback deployment ID и автодеплой неизвестны. Не считать исходный webapp готовым production artifact. |

Подготовка не подключалась к реальной БД, Storage, Auth, Telegram или Vercel.
GitHub использован только для проверки приватности и публикации собственной ветки.

## Локальные инструменты

Требуется Python 3.11+ для `tomllib`. Установка пакетов не нужна.
Запускайте из корня отдельного worktree:

```sh
python3 -m unittest discover -s tests/bb74 -v
python3 tools/release/preflight.py edge
python3 tools/release/preflight.py env --scope frontend
python3 tools/release/preflight.py env --scope edge
python3 tools/release/preflight.py env --scope bot
```

Env checker читает только окружение процесса, не открывает `.env`, не выполняет shell,
не отправляет запросы и выводит только фиксированные имена проверок.
Значения, длины и хеши секретов не выводятся. Передавайте секреты через защищённый runner,
не через аргументы команд или историю shell. Проверка формата не подтверждает валидность
ключа, его проект, совпадение BOT_TOKEN между компонентами или права в облаке.
Frontend проверяет публичные префиксы, но не заменяет сканирование итогового bundle.
Для PostgreSQL DSN используйте отдельный защищённый процесс, этот checker его не принимает.

`preflight.py edge` проверяет наличие entrypoint, конфигурацию JWT, check/test tasks,
lockfile, закреплённые npm imports, SHA-256 WASM, static_files, LICENSE и NOTICE.
Это статический preflight. Он не выполняет Deno resolution, проверку транзитивного графа
или bundle. Shared imports и динамические imports требуют отдельного Deno check.
Ожидаемый exit 1 на сохранённой базе:

- `bookings-write`: нет `deno.lock`.
- `notify-master` и `notify-user`: нет `deno.json`, `deno.lock`, прямой npm import закреплён только на major `@2`.

Не подавляйте эти блокеры. Передайте владельцу исходников на исправление и повторите проверку.

Для фиктивного комплекта используйте новый временный каталог:

```sh
scratch=$(mktemp -d /private/tmp/bb74-bundle.XXXXXX)
python3 tools/release/backup.py fixture "$scratch/source"
python3 tools/release/backup.py verify "$scratch/source"
python3 tools/release/backup.py restore "$scratch/source" --destination "$scratch/restored"
```

Манифест проверяет полный набор файлов, size, SHA-256, Auth user count,
Storage object count, уникальность bucket/key, MIME и соответствие файлов inventory.
Symlink, traversal, лишний файл, повреждение, пропуск компонента и существующая цель
отклоняются. Restore копирует файлы и повторно проверяет результат. Пакеты с kind,
отличным от `bb74-synthetic`, отвергаются. Это специально не инструмент реального backup.
SHA-256 доказывает целостность относительно манифеста, но не подлинность и не полноту
исходной системы. В настоящем процессе нужен отдельно защищённый inventory источника.

Для настоящего локального PostgreSQL roundtrip только с генерируемыми фиктивными данными:

```sh
python3 tools/release/pg_rehearsal.py --pg-bin /opt/homebrew/opt/postgresql@18/bin
```

Скрипт создаёт свежий кластер в `/private/tmp`, отключает TCP, очищает среду дочерних
процессов и подключается только к собственному Unix socket. URL и внешний SQL не принимает.
Выполняет pg_dump custom format и pg_restore в другую свежую БД, сравнивает JOIN,
Auth metadata и `sending` receipt. Затем останавливает свой кластер и удаляет его.
Это PostgreSQL 18.4, а не репетиция managed Supabase схем production PostgreSQL.
Восстановление настоящего Supabase, RLS и Storage API остаётся отдельным обязательным этапом.

## Контракт реального backup, только для будущего разрешённого окна

Назначьте ответственных за backup, SQL, Edge, frontend, bot и решение go/no-go.
Зафиксируйте согласованные RPO, RTO и предельную длительность окна до остановки сервиса.
Текущие production версии, объёмы и длительность восстановления неизвестны.
Не обещайте нулевой RPO без остановки всех writers.

1. После разрешения получите инвентарь от BB-73. Зафиксируйте PostgreSQL и Supabase
   версии, schemas, extensions, роли, grants, RLS, functions, triggers, sequences,
   migration history, cron и внешние writers. Проверьте совместимость dump/restore tools.
2. Подготовьте зашифрованное хранилище вне Git, доступ только у назначенных операторов,
   `umask 077`, retention и ключ восстановления в отдельном vault. Проверьте расшифровку
   на фиктивном файле. Не включайте персональные данные и секреты в отчёт или CI artifacts.
3. Закройте writers техническим механизмом, подтверждённым BB-73. Баннера недостаточно.
   Остановите polling или обработку webhook, cron, workers, API mutations и прямые клиенты.
   Дождитесь завершения транзакций и загрузок. Сохраните очередь Telegram без удаления updates.
4. Запишите backup ID, начало/конец UTC, Git SHA, версии tools, точный перечень схем,
   исключений и согласованную точку снимка. PostgreSQL dump должен охватывать public,
   нужные private schemas, Auth data/metadata и Storage metadata. Отдельно сохраните
   roles без раскрытия паролей, schema, data, sequences, ACL, RLS и историю миграций.
   Обычный Supabase CLI dump исключает managed schemas по умолчанию, поэтому его
   успешный exit code не доказывает наличие Auth и Storage. Проверьте TOC и явный scope.
   Не добавляйте managed DDL вслепую: способ экспорта и восстановления согласуйте
   с совместимыми managed schemas целевого локального Supabase.
5. Сохраните все Storage buckets, включая пустые и private, их public flag, limits,
   MIME restrictions и policies. Выгрузите все страницы списка объектов и байты через
   разрешённый Storage API. Для каждого bucket/key сохраните MIME, size, SHA-256,
   owner и необходимую metadata. Не используйте ETag как SHA-256. Сверьте количество,
   сумму размеров и список ключей с независимым source inventory. Проверьте avatar_url
   и ссылки на отсутствующие файлы. SQL backup не содержит байты объектов.
6. Auth требует users, identities и app/user metadata, а также зависимые Auth таблицы
   по фактической версии. Отдельно сохраните настройки providers, redirect allowlist,
   SMTP, templates, hooks, MFA и ссылки на секреты vault. Auth admin listUsers не является
   полным backup паролей, identities или sessions. Telegram app users могут жить в public.users,
   это не основание исключать auth schema. Отдельно решите судьбу sessions и refresh tokens.
7. Сохраните конфигурацию Edge, исходники, lockfiles, WASM, secret version references,
   JWT/API-key configuration references, Realtime publications, Vercel build settings,
   env scope names, deployment/alias IDs, bot transport, menu URL, webhook URL и pending
   update count. Секретные значения храните только в зашифрованном vault export.
8. Сформируйте манифест каждого файла и объекта. Подпишите его или сохраните digest
   отдельно от backup с ограничением изменения. Проверьте независимые counts по таблицам,
   PK, FK, sequences, Auth users/identities, buckets/objects и связи avatar. Нулевые
   counts допустимы только при подтверждённом нуле в source inventory.
9. Выполните restore в изолированный локальный Supabase без внешней отправки и с
   совместимыми managed schemas. Порядок: роли по согласованной карте, app schema,
   managed data по версии, app data, sequences, constraints/ACL/RLS, Storage bytes через API,
   конфигурация и только тестовые секреты. Не накатывайте managed DDL поверх несовместимой версии.
   Сверьте TOC, counts, hashes, FK, RLS под anon/authenticated, RPC под server role,
   private buckets и фактическое чтение каждого восстановленного файла.
10. Отрепетируйте точный upgrade BB-73 и rollback на этом снимке, измерьте RTO.
    Храните протокол с редактированными диагностическими данными. Без успешной репетиции
    реального scope backup выпуск не разрешать. Все реальные действия требуют отдельного разрешения.

## Развёртывание Edge после отдельного разрешения

На этой машине проверены `supabase --version` и `supabase functions deploy --help`.
Версия 3.0.0, цель remote-only у functions deploy, явный `--remote=<ref>`.
Не полагайтесь на linked project, текущий cwd или унаследованные переменные окружения.
CLI v3 изменил выбор целей и подтверждения hosted mutations. Не переносите команды v2
из старых отчётов без проверки `--help`. Автоматический скрипт deploy в BB-74 не создаётся.

1. Зафиксируйте approved Git SHA и версии CLI/Deno/runtime. Получите явный approved target
   из результатов BB-73. Проверьте отсутствие чужих credentials, `.temp` link и env overrides
   в изолированном release runner. Согласуйте SQL/RPC, bucket и key contracts для всех функций.
2. Добейтесь PASS статического preflight. Для каждой функции выполните Deno check/test
   с frozen lockfile. Предварительно прогрейте зависимости в контролируемом процессе,
   затем повторите с `--cached-only --frozen`. Не обновляйте lockfile во время выпуска.
   Notify-функциям нужны отдельные check/test contracts, сейчас это блокер.
3. Запустите тесты `master-avatar` с настоящим vendored WASM. SHA-256 ожидается
   `54629cbcf06dd10db38b4d87fa6ab241b248c09c94f2d9689506e5f994ac5f0c`.
   Проверьте static_files, module-relative путь, LICENSE/NOTICE. Повторите cold start
   в локальном Supabase Edge Runtime и обработку JPEG/PNG/WebP с фиктивным Storage.
   Проверьте лимиты памяти, 5 MiB, повреждённые и анимированные изображения.
4. Проверьте полученный bundle и присутствие WASM. Для static files используйте
   документированный Docker bundling path, не `--use-api`. Прямой Deno import не
   подтверждает упаковку или hosted cold start. Этот этап здесь не выполнен.
5. В закрытом окне применяйте только approved SQL BB-73. Установите только нужные
   секреты через защищённый канал. Deploy выполняйте по одному явному имени функции
   и явной цели CLI. Не используйте all-functions по умолчанию, `--prune`, глобальное
   отключение JWT или автоматическое подтверждение до проверки плана оператором.
6. Сначала profile/catalog/read/avatar и write API по карте зависимостей BB-73,
   затем уведомления, webhook последним и пока без переключения трафика.
   После каждой функции проверьте config, cold start, auth rejection, RPC/Storage contract,
   response shape и отсутствие секретов в логах. При ошибке остановите последовательность.
7. Запишите deployment identifiers и предыдущий совместимый комплект. Откат Edge
   должен сохранять новые ограничения RLS, историю бронирований и receipt semantics.

Документация проверки на 2026-11-08:
[CLI v3 changelog](https://supabase.com/changelog),
[backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[database backups](https://supabase.com/docs/guides/platform/backups),
[deploy](https://supabase.com/docs/guides/functions/deploy),
[WASM](https://supabase.com/docs/guides/functions/wasm).
Markdown changelog endpoint не прочитался через web и DNS shell, использована HTML-страница.

## Обслуживание, переключение и восстановление

До окна выберите технический maintenance gate с BB-73. Старые открытые Mini App должны
терять возможность мутаций на сервере, а не только видеть новую страницу. Согласуйте срок
жизни initData и уже выданных signed upload URLs. Подтвердите остановку всех writers,
затем снимите финальный согласованный backup БД и Storage.

После SQL и Edge разместите проверенный production artifact BB-73 в существующем
Vercel проекте. Сохраните предыдущий deployment ID и alias, проверьте env scope, исключение
server secrets, cache/version и запрет старых прямых записей. Сначала проверьте закрытый
preview по согласованному URL. Только затем переключайте alias. Сам push ветки BB-74
не является разрешением на автодеплой, настройки интеграции необходимо подтвердить перед выпуском.

Выберите один транспорт бота по фактическому состоянию BB-73. При переключении с polling
сначала остановите старый процесс. При переключении с webhook сначала остановите его
обработку без потери pending updates. Не используйте drop_pending_updates. URL меню, WEB_APP_URL
и webhook меняйте только по утверждённому плану, затем проверьте /start, /app, Mini App,
дубликаты updates и receipt states. Не повторяйте вслепую `sending`, сообщение могло уйти.

До открытия проведите согласованный smoke cycle на выделенном тестовом пользователе:
catalog, profile, avatar, booking, replay, conflict, confirm/reject, cancel, history,
чужой доступ и отсутствие initData. Сверьте старые rows и Storage с inventory.
Откройте writers одним решением ответственного и наблюдайте 401/403/5xx, latency,
конфликты/locks, queue growth, duplicate notifications и ошибки загрузки аватаров.

При нарушении целостности, auth contract, росте 5xx или очереди верните maintenance и
остановите writers. До открытия данных предпочтителен предыдущий совместимый Edge/frontend
или исправление вперёд. Если нужен restore, восстанавливайте только проверенный согласованный
комплект БД, Storage и конфигурации. Транзакция не откатывает уже завершённые шаги выпуска.
Старый frontend с публичными grants не является допустимым rollback после BB-01.
После открытия сначала сохраните и согласуйте новые записи/файлы, только затем выбирайте
repair или restore. Старый snapshot поверх новых бронирований уничтожает данные.
Внешние Telegram-сообщения и `sending` receipts требуют отдельной сверки.
