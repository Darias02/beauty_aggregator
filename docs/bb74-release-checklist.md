# BB-74: release checklist

Все пункты остаются открытыми до подтверждённого evidence. Этот файл не разрешает deploy.
Укажите release owner, дату окна, RPO/RTO, backup ID и approved Git SHA в закрытом протоколе.

## До окна

- [ ] BB-73 предоставила реальный schema/ACL/RLS/Storage/Auth audit и точный upgrade SQL.
- [ ] Исключён baseline поверх существующей БД, проверены grants, triggers и история бронирований.
- [ ] Известны активный bot transport, все writers и технический maintenance gate.
- [ ] Проверены приватность GitHub, branch protection, отсутствие автодеплоя BB-74 и Vercel build settings.
- [ ] Production artifact BB-73 проверен, не содержит server secrets, cache/version и restart gate работают.
- [ ] Исправлены lockfiles `bookings-write`, `notify-master`, `notify-user`; notify imports закреплены точно.
- [ ] `python3 -m unittest discover -s tests/bb74 -v` PASS.
- [ ] `preflight.py edge` PASS и env проверки каждого scope PASS без вывода значений.
- [ ] Deno frozen checks/tests всех функций PASS; каждый оставшийся lint defect разобран.
- [ ] WASM checksum, реальный decode, bundle, local Runtime cold start и лимиты подтверждены.
- [ ] Approved target, версии CLI/Deno/PostgreSQL и предыдущие deployment IDs записаны.
- [ ] Зашифрованный backup scope, независимый inventory, vault и доступ к recovery key проверены.
- [ ] Полный restore нужных managed schemas, Auth, Storage и upgrade/rollback отрепетированы локально.
- [ ] Измеренный RTO укладывается в окно. Назначены ответственные и условия остановки.
- [ ] Получено отдельное разрешение на конкретные реальные backup, SQL, deploy и bot/webhook изменения.

## Закрытое окно

- [ ] Все writers остановлены, транзакции и uploads завершены, pending updates сохранены.
- [ ] Финальный согласованный backup проверен по source counts, FK, inventory и SHA-256.
- [ ] Применён только approved SQL BB-73, каждый шаг и postcondition записаны.
- [ ] Каждая Edge Function развёрнута явно в approved target, без prune/use-api для WASM.
- [ ] Cold start, auth rejection, RPC, Storage и notifications contracts прошли.
- [ ] Production frontend проверен до alias switch, старые Mini App не обходят gate.
- [ ] Bot переключён с одним транспортом, очередь не сброшена, receipts сверены.
- [ ] Smoke cycle, старые строки и объекты проверены. Есть решение go/no-go.

## После открытия

- [ ] Writers открыты согласованно, errors/locks/queue/avatars/duplicates наблюдаются.
- [ ] При сбое обслуживание включено снова, новые данные сохранены до решения о restore.
- [ ] Протокол RPO/RTO, incidents и итог сверки сохранены без секретов.
- [ ] Backup retention и удаление временных расшифрованных копий выполнены по утверждённой политике.

Процедуры и ограничения: [runbook](bb74-release-runbook.md).
