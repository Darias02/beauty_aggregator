"""BB-64 only: real SQL in BB-63's disposable cluster; no real DSN or data."""
from concurrent.futures import ThreadPoolExecutor
import json

import pytest

from tests.bb63.test_slots_write import cluster, db, slot, wait_for_lock_holder


def cancel(identifier, master=201):
    return f"select bb64_cancel_slot({master},{identifier})"


def book(db, identifier, active=False):
    booking = json.loads(db(f"select bb24_book_slot(101,{identifier})"))["booking"]
    if active:
        db("update bookings set status='Активна'; update slots set status='Занят'")
    return booking


@pytest.mark.parametrize("active", [False, True])
def test_cancel_live_and_retry(db, active):
    identifier = slot(db)
    booking = book(db, identifier, active)
    assert "PT404" in db(cancel(identifier, 202), success=False)
    assert db("select status from bookings") == ("Активна" if active else "Ожидает подтверждения мастера")
    assert db("select coalesce(reason,'NULL') from bookings") == "NULL"
    query = "set role service_role; " + cancel(identifier)
    result = json.loads(db(query))
    assert result == {"deleted": False, "booking": {**booking, "status": "Отменена мастером", "reason": "plans"}}
    assert db("select status from slots") == "Отменен"
    assert json.loads(db(query)) == result
    assert "PT409" in db(f"select bb24_book_slot(101,{identifier})", success=False)
    assert "PT409" in db(f"select bb63_delete_slot(201,{identifier})", success=False)


def test_free_deletion_foreign_and_missing(db):
    identifier = slot(db)
    assert "PT404" in db(cancel(identifier, 202), success=False)
    assert db("select count(*) from slots") == "1"
    assert json.loads(db("set role service_role; " + cancel(identifier))) == {"deleted": True}
    assert "PT404" in db(cancel(identifier), success=False)
    assert db("select count(*) from slots") == "0"


def test_cancelled_model_history_is_preserved(db):
    identifier = slot(db)
    db(f"insert into bookings(user_id,slot_id,status,reason) values(101,{identifier},'Отменена мастером','model')")
    assert 'BB73_SLOT_HAS_HISTORY' in db(cancel(identifier), success=False)
    assert db("select count(*) from bookings") == "1"
    assert db("select status from slots") == 'Свободен'


@pytest.mark.parametrize("status", ["null", "'confirmed'", "'Выполнена'"])
def test_unknown_booking_state_fails_closed(db, status):
    identifier = slot(db)
    db(f"insert into bookings(user_id,slot_id,status) values(101,{identifier},{status})")
    assert "PT409" in db(cancel(identifier), success=False)
    assert db("select status from slots") == "Свободен"
    assert db("select count(*) from bookings") == "1"


def test_server_only_acl_and_arguments(db):
    identifier = slot(db)
    for role in ["anon", "authenticated"]:
        assert "42501" in db(f"set role {role}; " + cancel(identifier), success=False)
    for master, target in [(0, identifier), (201, 0), ("null", identifier)]:
        assert "PT422" in db(cancel(target, master), success=False)


@pytest.mark.parametrize("failure", ["raise", "skip"])
def test_sql_error_or_trigger_suppression_rolls_back_both_tables(db, failure):
    identifier = slot(db)
    book(db, identifier)
    body = "raise exception 'injected SQL failure';" if failure == "raise" else "return null;"
    db(f"""create function fail_slot() returns trigger language plpgsql as $$
        begin {body} end $$;
        create trigger fail_slot before update on slots for each row execute function fail_slot();""")
    assert ("injected SQL failure" if failure == "raise" else "PT409") in db(cancel(identifier), success=False)
    assert db("select status from bookings") == "Ожидает подтверждения мастера"
    assert db("select coalesce(reason,'NULL') from bookings") == "NULL"
    assert db("select status from slots") == "Ожидает подтверждения"


def race(db, first_query, second_query, second_fails=False):
    with ThreadPoolExecutor() as pool:
        first = pool.submit(db, "begin; set role service_role; " + first_query + "; select pg_sleep(.4); commit", blocker=True)
        wait_for_lock_holder(db)
        second = db("set role service_role; " + second_query, success=not second_fails)
        first.result()
    return second


@pytest.mark.parametrize("winner", ["booking", "cancel", "delete"])
def test_creation_and_deletion_races(db, winner):
    identifier = slot(db)
    book_query = f"select bb24_book_slot(101,{identifier})"
    delete_query = f"select bb63_delete_slot(201,{identifier})"
    if winner == "booking":
        result = json.loads(race(db, book_query, cancel(identifier)))
        assert result["deleted"] is False
        assert db("select status from bookings") == "Отменена мастером"
        assert db("select status from slots") == "Отменен"
    else:
        first = cancel(identifier) if winner == "cancel" else delete_query
        second = book_query if winner == "cancel" else cancel(identifier)
        assert "PT404" in race(db, first, second, True)
        assert db("select count(*) from slots") == "0"
        assert db("select count(*) from bookings") == "0"


def test_concurrent_cancellation_replays(db):
    identifier = slot(db)
    book(db, identifier)
    result = json.loads(race(db, cancel(identifier), cancel(identifier)))
    assert result["deleted"] is False
    assert db("select count(*) from bookings") == "1"
    assert db("select status from slots") == "Отменен"


@pytest.mark.parametrize("operation", ["confirm", "model", "plans"])
@pytest.mark.parametrize("cancel_first", [False, True])
def test_conditional_transition_races(db, operation, cancel_first):
    identifier = slot(db)
    book(db, identifier)
    status, reason, slot_status = {
        "confirm": ("Активна", "null", "Занят"),
        "model": ("Отменена мастером", "'model'", "Свободен"),
        "plans": ("Отменена мастером", "'plans'", "Отменен"),
    }[operation]
    # Same conditional booking mutation as the existing UI. All server writers
    # must hold the slot first; clients are blocked by BB-01, not migrated here.
    transition = f"""select 1 from slots where slot_id={identifier} for update;
        with changed as (update bookings set status='{status}',reason={reason}
            where slot_id={identifier} and status='Ожидает подтверждения мастера' returning slot_id)
        update slots set status='{slot_status}' where slot_id in (select slot_id from changed)"""
    first, second = (cancel(identifier), transition) if cancel_first else (transition, cancel(identifier))
    history_conflict = operation == "model" and not cancel_first
    result = race(db, first, second, second_fails=history_conflict)
    assert db("select count(*) from slots") == "1"
    assert db("select count(*) from bookings") == "1"
    if history_conflict:
        assert 'BB73_SLOT_HAS_HISTORY' in result
        assert db("select status from slots") == 'Свободен'
        assert db("select status || ':' || reason from bookings") == 'Отменена мастером:model'
    else:
        assert db("select status from slots") == "Отменен"
        assert db("select status || ':' || reason from bookings") == "Отменена мастером:plans"


def test_reverse_order_writer_conflicts_without_deadlock(db):
    identifier = slot(db)
    book(db, identifier)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(db, f"begin; select 1 from bookings where slot_id={identifier} for update; select pg_sleep(.4); select 1 from slots where slot_id={identifier} for update; commit", blocker=True)
        wait_for_lock_holder(db)
        assert "PT409" in db(cancel(identifier), success=False)
        first.result()
    assert db("select status from slots") == "Ожидает подтверждения"
    assert json.loads(db(cancel(identifier)))["deleted"] is False


@pytest.mark.parametrize("booked", [False, True])
def test_cancel_wins_over_concurrent_delete(db, booked):
    identifier = slot(db)
    if booked:
        book(db, identifier)
    failure = race(db, cancel(identifier), f"select bb63_delete_slot(201,{identifier})", True)
    assert ("PT409" if booked else "PT404") in failure
    assert db("select count(*) from slots") == ("1" if booked else "0")
    if booked:
        assert db("select status from slots") == "Отменен"
        assert db("select status || ':' || reason from bookings") == "Отменена мастером:plans"
