# BB-69: изолированная тестовая сборка

Из корня репозитория, Python 3 без дополнительных пакетов:

```sh
export BB_SUPABASE_URL='https://<TEST_PROJECT_ID>.supabase.co'
export BB_SUPABASE_PUBLISHABLE_KEY='sb_publishable_<TEST_KEY>'
python3 scripts/build_staging_frontend.py
```

Результат: `dist-staging/` с `index.html`, CSS и исходными ES-модулями.
Исходный `webapp/js/config.js` не перезаписывается. Сборщик копирует только
публичные типы файлов; скрытые файлы и прочие переменные окружения не копируются.
Project ID должен состоять из 20 строчных латинских букв/цифр.
Отсутствующие переменные, существующий project ID `bxzwfidujuejmrbqjmgo`,
существующий ключ, secret и legacy JWT (включая service-role) прерывают сборку.
При ошибке предыдущий `dist-staging/` удаляется, чтобы не разместить устаревший bundle.
Соответствие URL и publishable key проверяется владельцем тестового проекта:
сборщик работает офлайн и не проверяет ключ через Supabase.

Для последующего отдельного тестового Vercel-проекта: Framework Preset **Other**,
Root Directory — корень репозитория, Build Command —
`python3 scripts/build_staging_frontend.py`, Output Directory — `dist-staging`.
Задать обе переменные именно для Preview; не размещать исходный `webapp/` напрямую.
Без этих настроек автоматическое размещение статических исходников не изолировано.
Production-настройки существующего проекта не меняются. В BB-69 нет deploy.

Локальная проверка (Python 3 и Node.js 22):

```sh
python3 -m unittest discover -s tests/bb69 -p 'test_*.py' -v
node --experimental-vm-modules --test tests/bb69/master_records.test.mjs
```

Все тесты используют фиктивные данные; сетевые запросы к Supabase не нужны.
Клиентские ключи: [официальная документация Supabase](https://supabase.com/docs/guides/getting-started/api-keys).
