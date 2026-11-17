# BB-11 booking-create

POST JSON `{ "slot_id": 123, "init_data": "<Telegram.WebApp.initData>" }`.
Only those two fields are accepted; slot IDs must be positive safe integers.
BB-06 validates Telegram signature, user structure, and the existing 24-hour TTL.
The verified Telegram ID is passed as `p_user_id` to the server-only BB-24 RPC.
No user/profile creation, slot status checks, or booking writes are duplicated here.

Success: `{ "booking": { "booking_id", "user_id", "slot_id", "status", "reason" }, "replayed": false }`
(field names shown schematically). Live retries return the same booking with
`replayed: true`, including already confirmed bookings. All responses use no-store.

Errors use `{ "error": { "code", "message" } }`: 401 `UNAUTHORIZED`,
404 `PROFILE_NOT_FOUND` / `SLOT_NOT_FOUND`, 409 `SLOT_UNAVAILABLE` / `SLOT_EXPIRED`,
403 `BOOKING_FORBIDDEN`, 422 `INVALID_SLOT`. Unexpected RPC/transport/contract
failures return generic 500 `BOOKING_UNAVAILABLE`; missing server configuration
returns 503. Internal database messages and additional row fields are not returned.

The Mini App retains `createBooking(userId, slotId)` and `{ ...booking, slot }`.
The userId argument is ignored. Only this operation uses the new API; other booking
operations are unchanged. The existing success screen can use its selected slot
if display enrichment fails after a successful booking.

Notifications reuse the existing browser `sendNotification('notify-master', ...)`
only for a successful response with `replayed: false`. Notification failures do
not reject the saved booking. Delivery remains best effort: a lost initial API
response, browser closure, or notification failure may leave a booking without a
notification; replay intentionally does not resend it. There is no new outbox,
delivery ledger, or exactly-once delivery guarantee.

Local verification (Node 24.19+; no packages or network required), from repo root:

```sh
node supabase/functions/booking-create/tests/booking.test.mjs
```

Tests use the actual BB-06 validator and handler, mocked server RPC/SDK and browser
dependencies. They cover signed auth, identity tampering, success, live replay,
occupied/expired slots, missing profile, safe failures without table fallback,
notification suppression/failure, and the existing screen return contract. SQL
atomicity remains owned and tested by BB-24; these tests do not contact a database.
With Deno available, check the entrypoint using `deno task check` in this directory.

Runtime needs `BOT_TOKEN`, `SUPABASE_URL`, and server credentials supported by
`getAdminKey` (`SUPABASE_SECRET_KEYS.default` or `SUPABASE_SERVICE_ROLE_KEY`).
No server credential goes into webapp configuration. The config entry disables
the Supabase JWT gate because signed Telegram initData authenticates the request.
BB-24 migration and the existing table protections must be present when deploying.
This change does not deploy functions or change production.
