# Booking operations (BB-66/BB-67)

`POST /functions/v1/bookings-write` accepts signed Telegram `init_data`,
`booking_id`, and `action: "confirm" | "reject" | "cancel"`. Rejection requires
`reason: "model" | "plans"`. Other fields, including actor IDs, are rejected.
BB-06 verifies identity; the server-only `bb66_decide_booking` RPC authorizes
that identity against the locked slot owner. Apply the BB-66 migration after
BB-24, BB-63 and BB-64 before making this endpoint available.

The RPC locks the slot, then its bookings (NOWAIT), and changes both tables in
one transaction. Only a consistent pending booking can change. A matching
completed decision returns `replayed: true` without writes; conflicting decisions
or an inconsistent current slot/booking pair return a conflict. Historical model
rejections remain available to BB-24 and slots-read for model exclusion.

Responses preserve `{ booking, replayed }`. Existing UI helpers still return the
booking and use the existing notify-user payload only when `replayed` is false.
Notification delivery is best effort: a lost response, closed browser or delivery
failure can lose the notification. Replays do not send it again. Durable delivery
and deduplication at the notification service require a separate server outbox
and worker; this change does not modify notification endpoints or webhooks.

BB-67 adds `action: "cancel"`, requiring `reason: "time" | "other"`.
Apply the BB-67 migration before using cancellation. The server-only
`bb67_cancel_booking` RPC authorizes the signed actor against `bookings.user_id`
after locking the slot and bookings. Consistent pending/waiting or active/busy
pairs become `Отменена моделью` / `Свободен` atomically. Invalid or terminal
states conflict; an identical cancellation of the still-free slot replays without
writes. A rebooked slot conflicts and is never released by a historical retry.
`cancelBooking(bookingId, reason)` still returns the booking row. Only a new
cancellation sends the existing `notify-master` / `model_cancelled` payload;
notification failure does not hide committed success. Delivery remains best effort.

Checks: `python3 -m pytest tests/bb67 tests/bb66 tests/bb64 -q` uses only disposable
local PostgreSQL with prepared schemas and all migrations. Handler, RPC adapter,
and browser contract tests are in `tests/write.test.ts`.
