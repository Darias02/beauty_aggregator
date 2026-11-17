"""Server-only booking boundary for the future authenticated API.

BB-05/BB-06 must validate the session/Telegram initData and resolve
``verified_user_id`` to public.users.user_id. Do not take it from a request body,
model_id, master_id, initDataUnsafe, or an unverified Telegram user object.

Inject a server-owned service_role Supabase client; this module intentionally
does not import database.client, load .env, expose an HTTP route, or fall back
to browser table writes. BB-01 must protect direct table writes before enabling
the future API. No service credentials belong in webapp/.

API contract: accept only slot_id from the client, derive verified_user_id from
authentication, call once, return booking + replayed after RPC success. Preserve
PostgREST error codes: PT404 (missing slot/user), PT409 (unavailable, expired or
inconsistent state), PT403 (model rejected), PT422 (invalid IDs). Treat unexpected
database failures as server errors. Do not turn them into successful bookings.
Retry the same user/slot after transport uncertainty; a live booking is returned
without a second insert, including after confirmation or appointment time.
After cancellation, a new request can create a new booking where allowed.
This is live-booking idempotency, not a permanent request-key ledger.

No notifications, cancellation, confirmation, or payment side effects run here.
The existing client and repository flows need a separate authenticated cutover.
"""

from typing import Any, Protocol


class _RpcResponse(Protocol):
    data: dict[str, Any]


class _RpcRequest(Protocol):
    def execute(self) -> _RpcResponse: ...


class BookingServerClient(Protocol):
    def rpc(self, name: str, params: dict[str, int]) -> _RpcRequest: ...


def book_slot_for_verified_user(
    *,
    server_client: BookingServerClient,
    verified_user_id: int,
    slot_id: int,
) -> dict[str, Any]:
    """Invoke one database transaction after server authentication.

    The caller is the trust boundary: a Python integer validates ID syntax,
    not identity. This helper does not authenticate arbitrary browser IDs.
    Database exceptions are deliberately propagated; never retry via INSERT.
    """
    for name, value in (("verified_user_id", verified_user_id), ("slot_id", slot_id)):
        if type(value) is not int or not 0 < value <= 2**63 - 1:
            raise ValueError(f"{name} must be a positive PostgreSQL bigint")

    return server_client.rpc(
        "bb24_book_slot",
        {"p_user_id": verified_user_id, "p_slot_id": slot_id},
    ).execute().data
