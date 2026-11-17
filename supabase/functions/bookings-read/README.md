# BB-65: private booking reads

`POST /functions/v1/bookings-read` authenticates Telegram `init_data` with the
existing BB-06 validator (including its server-owned TTL). Supabase JWT verification
is disabled only at the gateway; no privileged repository is created until Telegram
authentication and request validation pass. BOT_TOKEN, SUPABASE_URL and a server key
use the existing shared configuration. Responses and browser requests use no-store.

Requests:

- `{action: "booking", booking_id, init_data}` → `{booking}` (null for missing/foreign).
- `{action: "user", before?, init_data}` → `{bookings, next_cursor}`.
- `{action: "master", before?, init_data}` → `{bookings, next_cursor}`.

No actor IDs, query parameters or additional filters are accepted. All ownership
predicates use the verified Telegram ID, which matches users.user_id and
masters.master_id in tests/bb24/schema.sql. A model query filters bookings.user_id;
a master query uses slots!inner and slots.master_id, in the same database request.
A single read tries those two ownership-scoped queries. No user/master profiles,
phone numbers or wildcard columns are selected. The handler additionally checks
ownership and projects only the existing UI fields, including slots.services.
Telegram IDs needed by the existing contact buttons remain in this projection.

Lists retain every status/reason and past slot, including pending, active and
cancelled bookings. User records retain nullable slot/service relations from the
schema; a master must have an existing owned slot. Pages sort by the unique
booking_id descending and use an exclusive `before` cursor with a maximum of 500
rows per HTTP response. Even a short page returns its last ID; only an empty page
ends pagination. This tolerates PostgREST caps below 500 and lists above 1000,
without slot-ID IN lists or offset drift after deletions/newer inserts. Pages are
live reads, not a transaction snapshot. The browser collects all pages for the
unchanged function signatures and rejects malformed/non-progressing cursors and
later-page errors without exposing partial lists or using a table fallback.

BB-24 enrichment now reads the saved, owned booking's nested slot: the public
slots API deliberately hides a slot after booking. Read/notification failures
still return the committed booking; the success screen can use its selected slot.
The booking-create RPC, replay, notifications and all confirm/reject/cancel write
implementations remain unchanged. Those legacy browser writes remain separate work
and are blocked by the prepared BB-01 grants when applied.

Compatibility was checked locally against tests/bb24/schema.sql, BB-01, BB-24,
BB-63 and BB-64 migrations. No new schema changes are needed: service_role retains
server SELECT under BB-01; existing status values and cascade semantics remain.
No live Supabase access, SQL execution, migration application or deployment.

Targeted checks, when Deno is available:

```
cd supabase/functions/bookings-read
deno task check
deno task test
```

The tests use the SDK with a fake PostgREST HTTP transport, signed local Telegram
fixtures and the real browser client/handler/card renderer. No database is used.
Node 24 can also run the tests with --experimental-transform-types and an import
hook resolving @supabase/supabase-js to version 2.118.0. In this environment the
SDK's public standalone bundle was loaded from /tmp for that hook; it is not a
runtime dependency or a change to the app. Deno is unavailable, so Deno type-check
was not run. The existing booking-create and slots read/write tests also pass.
Python boundary tests could not load their shared conftest because pgserver is
missing; SQL tests were not run.
