# BB-76: порядок реального выпуска

Ни один пункт ниже не разрешает облачных действий. Все девять этапов остаются
незавершёнными до отдельного согласования и фактических свидетельств.
Локальная интеграция и фиктивные репетиции завершены, см. [отчёт](bb76-prelaunch-integration.md).

1. [ ] Проверка состояния существующей Supabase. Обновить аудит BB-73 от 13 ноября,
   сверить schema/data drift, версии, RLS/grants/Storage, constraints/triggers,
   Auth и migration history. Утвердить SHA, десять выбранных SQL и способ ledger adoption.
   Не применять BB-70 или весь каталог миграций. Проверить все writers, bot transport,
   hosting paths/cache, старые клиенты, env scopes без вывода значений.
2. [ ] Согласованный backup БД и Storage. Получить отдельное разрешение; утвердить
   owner, RPO=0/RTO, шифрование, vault/recovery keys и техническую остановку writers
   для согласованной точки. Включить schema/data/ACL/sequences/ledger, Auth,
   managed metadata, Storage bytes, inventory/связи/MIME/размеры/SHA-256 и config references.
   Независимо сверить counts и полноту, даже если предыдущий аудит нашёл ноль объектов.
3. [ ] Восстановление реального backup в изолированной локальной среде. Использовать
   совместимый PostgreSQL 17 и managed Auth/Storage. Заблокировать outbound Telegram.
   Сверить все строки, связи, sequences, ACL/RLS/Auth, файлы/аватары и hashes.
   Измерить RTO. Synthetic fixtures и PG18 stand-ins этот пункт не закрывают.
4. [ ] Репетиция обновления на восстановленной копии. Строгий SQL preflight,
   десять согласованных миграций с manifest hashes, проверка истории, API-контрактов,
   гонок/повторов, Storage, rollback/failure recovery. Зафиксировать go/no-go критерии.
   Не ослаблять preflight при drift. При PG18 constraint drift остановиться.
5. [ ] Закрытое окно обслуживания. Отдельно согласовать окно и изменения. Технически
   остановить clients/API mutations, polling/webhook processing, cron/workers и все
   privileged writers. Дождаться in-flight/uploads, сохранить Telegram pending updates.
   Снять свежий финальный согласованный backup, повторить preflight и сверку со снимком.
6. [ ] Согласованные SQL-миграции и Edge deploy. Только выбранный маршрут,
   с записью каждого результата и фактических ledger versions. Проверить BB-01/03,
   RESTRICT/history/CRUD и client denials. Развернуть каждую функцию в approved target,
   проверить lock/bundle/WASM static_files/cold start/лимиты и конфигурацию секретов.
7. [ ] Production frontend и Telegram. Разместить проверенный artifact сначала
   в maintenance. Проверить no-store, versioned assets, boot/initData/release gate,
   совместимость старых открытых окон. Переключить существующего бота одним транспортом,
   без сброса очереди; webhook/URL менять только при отдельном разрешении.
8. [ ] Hosted и мобильные E2E-тесты. В согласованном тестовом scope проверить полный
   цикл записи, права, аватары, WASM, настоящую доставку уведомлений, receipts/replays,
   native Telegram WebView на iOS/Android, клавиатуры/safe areas/cache/offline/перезапуск.
   Сверить старые строки/Storage bytes с backup. Chrome viewport этот пункт не закрывает.
9. [ ] Открытие приложения и наблюдение. Одно решение go/no-go; согласованно открыть
   writers и gate. Наблюдать ошибки, блокировки, гонки/дубли, аватары и Telegram queue.
   При сбое вернуть maintenance, сохранить новые данные до решения о восстановлении.

Откат не должен возвращать публичные grants, CASCADE или опасный delete RPC.
После открытия writers нельзя затирать новые записи старым snapshot. Telegram-сообщения
не откатываются вместе с БД. Сохранять совместимые предыдущие Edge/frontend артефакты.
Реальные backup/SQL/deploy/бот/webhook/Vercel требуют отдельного разрешения владельца.
