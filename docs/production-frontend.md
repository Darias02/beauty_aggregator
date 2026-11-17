# Подготовка production frontend Beauty Booking

Это локальная подготовка, не команда публикации и не заключение о готовности базы.
Production build использует только `bxzwfidujuejmrbqjmgo`. BB-69 staging builder
остаётся неизменным и продолжает запрещать этот проект.

## Сборка

Владелец предварительно сверяет соответствие publishable key существующему проекту.
Офлайн нельзя доказать принадлежность непрозрачного ключа URL. Не использовать secret,
service_role или legacy JWT. Не записывать ключ в Git, shell history или отчёт.
Передать публичный ключ через `BB_PRODUCTION_PUBLISHABLE_KEY`, затем выполнить:

```sh
python3 scripts/build_production_frontend.py
```

Сборщик не читает `.env`, не обращается к облаку и не использует `BB_SUPABASE_*`.
Результат `dist-production/` игнорируется Git. URL жёстко закреплён; override отсутствует.
При `VERCEL_ENV=preview/development` сборка запрещена. По умолчанию manifest содержит
`maintenance=true`: приложение не загрузится и не отправит Edge-запросы.

Для подготовки открытого варианта после всех проверок и отдельного разрешения выпуска:

```sh
BB_PRODUCTION_MAINTENANCE=false python3 scripts/build_production_frontend.py
```

Это тоже только офлайн-сборка. Реальную публикацию выполнять отдельно, после согласования.
В этом этапе тесты используют фиктивный ключ исключительно во временных каталогах;
готовый к размещению bundle с реальным ключом не создавался.

Публичные ресурсы копируются по allowlist, скрытые/служебные файлы исключаются,
symlink, secret/JWT и чужой project URL прерывают сборку. Ошибка удаляет старый output,
чтобы его нельзя было принять за новый успешный bundle. Исходный webapp не переписывается.

`release.json` содержит версию и maintenance. JS/CSS доступны по
`releases/<content-hash>/...`; `artifact-manifest.json` содержит SHA-256 всех остальных
файлов артефакта. Одинаковые входные файлы/ключ дают одинаковую версию.
Изменение maintenance не меняет JS-версию, но меняет хеш manifest-файла.
Сохранить оба согласованных артефакта и их manifest вне Git перед будущим переключением.

## Загрузка Mini App

Сгенерированный `boot.js` сначала проверяет manifest, затем наличие Telegram initData,
и лишь затем импортирует `app.js`. Прямая загрузка вне Telegram показывает сообщение.
Проверка не подменяет серверную проверку подписи initData и не доверяет initDataUnsafe.
Неиспользуемый плавающий Supabase SDK script исключён из production HTML;
data-модули текущего приложения используют fetch к Edge API.

`release-gate.js` проверяет manifest на focus/pageshow/возврате из background и перед
каждым запросом к `/functions/v1/` закреплённого Supabase origin. Запрос manifest использует
no-store, без credentials и redirects, с таймаутом 8 секунд. При несовпадении версии,
maintenance или ошибке приложение блокируется до перезагрузки, исходный API-запрос
с initData не отправляется. Нет retry или обхода через таблицы.

Это защищает только клиентов, уже загрузивших новый boot. Старые legacy Mini App без
этого кода остаются причиной закрытого окна и отзыва прежних клиентских прав.
Запрос, прошедший проверку до начала обслуживания, может уже выполняться; перед backup
нужно остановить writers и дождаться завершения in-flight операций. UI-guard не заменяет
контроль доступа БД или шлюза. Кэш, потеря сети и ограничение native Telegram WebView
должны отдельно проверяться после согласованного hosted-развёртывания.

## Конфигурация hosting

`config/vercel-production.example.json` является только проектом конфигурации.
Он не подключён к Vercel, не является корневым vercel.json и не меняет текущие builds.
После разрешения владелец должен согласовать production build command/outputDirectory
и no-store headers для `/`, `/index.html`, `/release.json`, `/artifact-manifest.json`.
Описание свойств: [Vercel project configuration](https://vercel.com/docs/project-configuration).
Проверить фактические HTTP headers, CDN и browser cache после размещения.

Поддерживается Mini App на корне origin. Если фактический WEB_APP_URL содержит subpath,
его нужно установить при аудите hosting и адаптировать base path до выпуска.
Не переключать Preview на production builder или существующую БД. Сохранять прежние
совместимые артефакты для отката и, при необходимости, старые content-hash ресурсы
для ещё открытых клиентов. Простая смена URL бота не обновляет открытое окно.

## Проверки

```sh
python3 -m unittest discover -s tests/bb73 -p 'test_production_build.py' -v
deno test --allow-read tests/bb73/release_gate.test.mjs
python3 -m unittest discover -s tests/bb69 -p 'test_staging_build.py' -v
```

Тест emitted boot выполняет действительный сгенерированный загрузчик с fake DOM,
fake Telegram и fake fetch без разрешения network. Это проверка логики и графа импортов,
не тест native Telegram WebView. Реальные Supabase/Telegram credentials не используются.
