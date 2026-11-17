# BB-63 / BB-64 slots-write

POST JSON with signed Telegram `init_data` and `action`:

- `create`: `service_id`, `date_time`, `city`, optional `address` and `description`.
- `delete`: `slot_id` only.
- `cancel`: `slot_id` only; returns `{ deleted: true }` or `{ deleted: false, booking }`.

BB-06 authenticates before repository creation. Unknown fields (including owner,
status and role) are rejected. The existing master must match the signed Telegram
ID. Services are checked against `public.services`; the actual schema has no city
catalog or per-master service association. `date_time` is an RFC3339 instant with
seconds and an explicit timezone; invalid calendar dates and past instants fail.
City/address/description are text in the schema. API policy limits them to
200/500/2000 Unicode characters; city is required, address/description may be empty.
The request body is bounded to 16 KiB.

Server-only SECURITY INVOKER RPCs use the existing service role and BB-01 table
protection. Creation relies on `slots_one_live_time_per_master` from
`20260930_bb.sql`, whose live statuses are Свободен / Ожидает подтверждения / Занят.
A unique violation is returned as a conflict; no retry/upsert/fallback is used.
Clock time is checked after FK locks and after insertion (which can wait on the
unique index). The migration preserves the index and all existing data.

Deletion locks the slot in the same order as BB-24, verifies its owner and exact
Свободен status. BB-73 then rejects any linked booking, including cancelled,
unknown and NULL states, with PT409 / BB73_SLOT_HAS_HISTORY. The Edge API maps this
to HTTP 409 / SLOT_HAS_HISTORY for both delete and cancel, and the client explains
that history is preserved. The existing CASCADE FK is unchanged, but these RPCs
never delete a slot with booking history. A missing or
foreign slot returns the same error. These RPCs are not executable by PUBLIC, anon or
authenticated. The browser keeps `createSlot(options)` / `deleteSlot(slotId,
masterId)` contracts and ignores the legacy master ID.

BB-64 moves `cancelSlot(slotId, masterId)` to the same authenticated API. The
legacy masterId is ignored; no browser booking reads, writes or fallback remain.
`bb64_cancel_slot` locks the slot, checks ownership, then locks its bookings in
booking_id order. NOWAIT converts a booking lock held by a writer using reverse
lock order into PT409, avoiding a lock cycle. BB-24 creates and BB-63 deletes
serialize on the slot. Unknown booking/slot states fail closed. A live pending or
active booking is changed to Отменена мастером / plans and the slot to Отменен in
one transaction. A free slot without live bookings delegates to bb63_delete_slot,
including BB-73's history guard. A completed plans cancellation replays
its booking; retrying a deleted slot returns PT404. Write errors or suppressed
trigger updates roll back the entire RPC.

All server booking writers must follow BB-24's slot-before-booking protocol and
recheck state while holding locks. The legacy confirm/reject browser operations
remain untouched and are blocked by BB-01 table permissions. This change does not
make their separate table requests atomic or authorize them; an unrestricted
legacy service-role writer can still overwrite state after any transaction.

Schema was checked against the existing metadata snapshot in tests/bb24/schema.sql
and the migrations (bigint IDs, text statuses/reason, ON DELETE CASCADE and both
partial unique indexes). A fresh read of live metadata was denied in this session;
no live schema verification or SQL execution was performed.

Before any future deployment, the migration must be reviewed and applied by the
normal process. This task does not apply it to an existing database or deploy the
function. Supabase CLI was unavailable, so the migration file was prepared locally.

BB-73 adds `20261108184749_bb73_preserve_booking_history.sql` after the historical
migrations; the old BB-63/64 SQL is retained. Apply the complete reviewed sequence
before enabling these endpoints. The patch is verified locally, not approved for
an existing production schema. Direct privileged deletes and other CASCADE paths
remain outside this RPC guard and require the live-schema audit.

Checks when Deno is available (run in this folder):

```
deno task check
deno task test
```

The handler and client tests also run with Node 24 and
`--experimental-transform-types --test tests/*.test.ts`. No Deno API is used in
these tests. SQL tests: `python3 -m pytest tests/bb63 -q` from the repository root;
they create an isolated local cluster with TCP disabled and never read a DSN/.env.


BB-64 targeted SQL tests: `python3 -m pytest tests/bb64 -q`. These reuse BB-63's
isolated PostgreSQL fixtures and test cancellation/replay, ownership, pending and
active bookings, deletion, SQL rollback, ACLs and competing writers in both orders.
Deno is unavailable in the implementation environment; handler/client tests run
using the existing Node 24 runtime, without installing dependencies.
