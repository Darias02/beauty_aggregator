# Slots read API (BB-61)

POST JSON to `slots-read` with signed Telegram `init_data` and an action:

- `available`: `service_id`, optional `city`. Returns `{ slots }` for future
  `Свободен` slots, excluding this Telegram user's `model` rejections.
- `slot`: `slot_id`. Returns `{ slot }`; missing and inaccessible slots both return
  `null`. Owners may read their own slots in any status/date. Other users may read
  only future free slots without a matching rejection.
- `master`: no actor ID. Returns `{ slots }` belonging to the verified Telegram ID,
  including past slots and all statuses for the existing active/archive UI.

Browser actor IDs are never accepted. Responses contain only the slot columns in
`tests/bb24/schema.sql` and `services: { service_id, name } | null`, without booking
or profile data. Pagination uses stable date/ID ordering and actual returned page
lengths, including server caps smaller than 500. Page failures reject the whole
request rather than return partial data.

Uses the existing BB-06 validator and its 24-hour TTL, `BOT_TOKEN`, `SUPABASE_URL`,
and the existing server key resolver. `verify_jwt = false` delegates authentication
to the handler; requests still require valid signed Telegram initData.

From this directory run `deno task check`, `deno task test`, and `deno task lint`.
Tests use the real Supabase SDK with a mock HTTP transport; they never access a
database. No SQL, deployment, or write/booking operation is part of this change.
