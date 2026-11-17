import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


# Load only the pure server helper. Importing database.client would load .env
# and create a real network client, which these tests must never do.
spec = importlib.util.spec_from_file_location(
    "atomic_booking", Path(__file__).resolve().parents[2] / "database/atomic_booking.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
book_slot = module.book_slot_for_verified_user


def test_one_rpc_preserves_server_verified_bigint():
    result = {"booking": {"booking_id": 1}, "replayed": False}
    client = Mock()
    client.rpc.return_value.execute.return_value = SimpleNamespace(data=result)
    assert book_slot(
        server_client=client, verified_user_id=9007199254740993, slot_id=1
    ) == result
    client.rpc.assert_called_once_with(
        "bb24_book_slot", {"p_user_id": 9007199254740993, "p_slot_id": 1}
    )
    client.rpc.return_value.execute.assert_called_once_with()
    client.table.assert_not_called()


def test_error_propagates_without_partial_fallback_or_retry():
    client = Mock()
    failure = RuntimeError("transaction failed")
    client.rpc.return_value.execute.side_effect = failure
    with pytest.raises(RuntimeError) as error:
        book_slot(server_client=client, verified_user_id=101, slot_id=1)
    assert error.value is failure
    client.rpc.assert_called_once()
    client.table.assert_not_called()


@pytest.mark.parametrize("field", ["verified_user_id", "slot_id"])
@pytest.mark.parametrize("value", [None, True, False, "101", 1.5, 0, -1, 2**63])
def test_unvalidated_identifier_syntax_never_reaches_rpc(field, value):
    client = Mock()
    args = {"verified_user_id": 101, "slot_id": 1, field: value}
    with pytest.raises(ValueError):
        book_slot(server_client=client, **args)
    client.rpc.assert_not_called()
