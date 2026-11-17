# BB-75: локальные браузерные проверки

Тесты запускают frontend в установленном Google Chrome с фиктивными API и Telegram WebApp.
Supabase, Telegram credentials, `.env` и production builder не используются.

## Запуск

Нужны Python 3.13 и установленный Google Chrome. Установка зависимостей требует разрешения владельца окружения.
В этой сессии разрешение получено. Браузеры Playwright скачивать не нужно.

```sh
python3 -m venv venv
venv/bin/python -m pip install -r tests/bb75/requirements.txt
venv/bin/python -m pytest tests/bb75 -q --tb=short --junitxml=tests/bb75/artifacts/results.xml
```

Для владельца на Mac: дважды нажмите `Open Beauty Booking.command` в корне проекта.
Подробности в [инструкции локального запуска](../../docs/local-miniapp.md).
Preview использует только стандартную библиотеку Python, без установки зависимостей.

Для просмотра интерфейса вручную:

```sh
venv/bin/python tests/bb75/serve_mock.py
```

Откройте `http://127.0.0.1:8075`. Сервер слушает только loopback.
Профили, каталог и записи существуют в памяти процесса. Перезапуск сбрасывает состояние.
Уведомления и ссылки Telegram показываются только как mock-действия.

## Изоляция

`serve_mock.py` отдаёт изменённые в памяти `index.html` и `config.js`.
Из HTML удаляются внешние шрифты и SDK. Подмена config проверяется до запуска сервера; при ошибке запуск останавливается.
Адрес API заменяется на `location.origin`,
ключ заменяется на `bb75-mock-only`. Исходные файлы конфигурации не меняются.
CSP на всех ответах разрешает `connect-src 'self'`; fetch guard отклоняет внешние URL.
Query strings и URL-кодирование не позволяют получить исходный config.
Открытие внешних окон и переходы по внешним ссылкам перехватываются. Сервер не содержит HTTP-клиента к внешним сервисам.

Браузерный fixture дополнительно перехватывает все запросы. API обрабатывает `MockAPI`.
Любой неожиданный внешний запрос блокируется и проваливает проверку.
Service workers отключены. `initData` имеет заведомо недействительную mock-подпись.
Тесты проверяют клиентское поведение, а не подлинность Telegram-пользователя.

## Артефакты

`tests/bb75/artifacts/` исключён из Git. После прогона там находятся:

- `results.xml`: JUnit-результат при использовании команды выше;
- `environment.json`: версии Python и Chrome;
- PNG каждого браузерного сценария;
- ZIP каждого Playwright trace.

Локальный просмотр trace:

```sh
venv/bin/playwright show-trace tests/bb75/artifacts/test_booking_and_model_cancel.zip
```

## Границы проверки

Mock API не реализует RLS, проверку подписей, транзакции, конкурентный доступ к базе,
обработку изображений или доставку сообщений. Загрузка PNG проверяет форму, клиентскую
валидацию, multipart-запрос, ответ API и отображение аватара. Хранение изображения не проверяется.

Экраны 320×568, 360×640, 390×844 и 430×932 проверяются в headless Chrome.
Это не проверка Telegram WebView на физических iOS и Android устройствах.
Нативные клавиатуры, safe areas, системные жесты и настоящий запуск из бота остаются
отдельной интеграционной проверкой. Тесты BB-75 не дают оснований утверждать, что Telegram-доставка работает.

## Production artifact regression BB-76

Те же сценарии выполняются на настоящем emitted bundle BB-73:

```sh
venv/bin/python -m pytest tests/bb75 --production-artifact -q -p no:cacheprovider
```

Builder использует только фиктивный publishable key, maintenance=false и временный
output. Telegram SDK/fonts и все API перехватываются в Chrome, внешней сети нет.
Дополнительно проверяется запрет отправки API при смене release/maintenance.
Production PNG/trace имеют префикс `production-`. Это не hosted Telegram E2E.
