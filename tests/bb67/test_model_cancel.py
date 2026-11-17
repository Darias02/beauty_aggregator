"""BB-67: prepared migrations in disposable PostgreSQL; no real Supabase."""
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from tests.bb63.test_slots_write import cluster, db, wait_for_lock_holder
from tests.bb64.test_slot_cancel import race, cancel
from tests.bb66.test_booking_decisions import prepare, decide


def model_cancel(booking, reason="'time'", user=101):
    return f"select bb67_cancel_booking({user},{booking},{reason})"


@pytest.mark.parametrize("active", [False, True])
@pytest.mark.parametrize("reason", ["time", "other"])
def test_owned_cancel_and_replay(db, active, reason):
    target, booking = prepare(db)
    if active:
        db(decide(booking))
    before = json.loads(db(f"select to_jsonb(b) from bookings b where booking_id={booking}"))
    query = "set role service_role; " + model_cancel(booking, f"'{reason}'")
    result = json.loads(db(query))
    assert result == {"booking": {**before, "status": "Отменена моделью", "reason": reason}, "replayed": False}
    assert db("select status from slots") == "Свободен"
    assert json.loads(db(query)) == {**result, "replayed": True}
    assert "PT409" in db(model_cancel(booking, "'other'" if reason == "time" else "'time'"), success=False)
    db(f"select bb24_book_slot(101,{target})")
    assert "PT409" in db(query, success=False)
    assert db("select status from slots") == "Ожидает подтверждения"
    assert db("select count(*) from bookings where status='Ожидает подтверждения мастера'") == "1"


def test_owner_missing_and_server_only_acl(db):
    _, booking = prepare(db)
    for actor in [201, 102]:
        assert "PT404" in db(model_cancel(booking, user=actor), success=False)
    assert "PT404" in db(model_cancel(99999), success=False)
    for role in ["anon", "authenticated"]:
        assert "42501" in db(f"set role {role}; " + model_cancel(booking), success=False)
    assert db("select status from bookings") == "Ожидает подтверждения мастера"
    assert db("select status from slots") == "Ожидает подтверждения"


@pytest.mark.parametrize("args", ["null,1,'time'", "0,1,'time'", "101,null,'time'", "101,0,'time'", "101,1,null", "101,1,'model'", "101,1,'plans'", "101,1,''"])
def test_invalid_arguments(db, args):
    assert "PT422" in db(f"select bb67_cancel_booking({args})", success=False)


@pytest.mark.parametrize("bs,ss,reason", [
    ("Отменена мастером", "Свободен", "model"),
    ("Отменена мастером", "Отменен", "plans"),
    ("Отменена моделью", "Свободен", "other"),
    ("Отменена моделью", "Занят", "time"),
    ("Активна", "Ожидает подтверждения", None),
    ("Ожидает подтверждения мастера", "Занят", None),
    ("Ожидает подтверждения мастера", "Свободен", None),
    ("Ожидает подтверждения мастера", "Отменен", None),
    ("Ожидает подтверждения мастера", None, None),
    ("Ожидает подтверждения мастера", "Ожидает подтверждения", "time"),
    (None, "Ожидает подтверждения", None),
    ("confirmed", "Ожидает подтверждения", None),
])
def test_inconsistent_and_terminal_records_unchanged(db, bs, ss, reason):
    _, booking = prepare(db)
    lit = lambda v: "null" if v is None else "'" + v + "'"
    db(f"update bookings set status={lit(bs)},reason={lit(reason)}; update slots set status={lit(ss)}")
    snapshot = db("select to_jsonb(b) from bookings b; select to_jsonb(s) from slots s")
    assert "PT409" in db(model_cancel(booking), success=False)
    assert db("select to_jsonb(b) from bookings b; select to_jsonb(s) from slots s") == snapshot


@pytest.mark.parametrize("table", ["bookings", "slots"])
@pytest.mark.parametrize("failure", ["raise", "skip", "rewrite"])
def test_sql_failure_rolls_back_both_writes(db, table, failure):
    _, booking = prepare(db)
    body = {"raise": "raise exception 'injected failure';", "skip": "return null;", "rewrite": "new.status := 'unexpected'; return new;"}[failure]
    db(f"create function fail_write() returns trigger language plpgsql as $$ begin {body} end $$; create trigger fail_write before update on {table} for each row execute function fail_write()")
    assert ("injected failure" if failure == "raise" else "PT409") in db(model_cancel(booking), success=False)
    assert db("select status from bookings") == "Ожидает подтверждения мастера"
    assert db("select status from slots") == "Ожидает подтверждения"
    assert db("select reason is null from bookings") == "t"


@pytest.mark.parametrize("reason", ["time", "other"])
def test_concurrent_duplicate_replays(db, reason):
    _, booking = prepare(db)
    query = model_cancel(booking, f"'{reason}'")
    assert json.loads(race(db, query, query))["replayed"] is True


@pytest.mark.parametrize("operation", ["confirm", "model", "plans", "slot"])
@pytest.mark.parametrize("model_first", [True, False])
def test_races_with_master_operations(db, operation, model_first):
    target, booking = prepare(db)
    master = cancel(target) if operation == "slot" else decide(booking) if operation == "confirm" else decide(booking, "reject", f"'{operation}'")
    query = model_cancel(booking)
    # Confirmation first permits the model to cancel the resulting active record.
    # Model first makes confirmation/rejection conflict. BB-73 also rejects
    # slot deletion after model cancellation, preserving its history.
    fails = model_first or (not model_first and operation != "confirm")
    result = race(db, query if model_first else master, master if model_first else query, fails)
    if fails:
        assert "PT409" in result
    if model_first and operation == "slot":
        assert 'BB73_SLOT_HAS_HISTORY' in result
    assert db("select count(*) from slots") == db("select count(*) from bookings") == "1"
    expected = "Отменена моделью" if model_first or operation == "confirm" else "Отменена мастером"
    assert db("select status from bookings") == expected
    assert db("select status from slots") == ("Отменен" if not model_first and operation in ["slot", "plans"] else "Свободен")


def test_reverse_lock_conflict_without_deadlock(db):
    target, booking = prepare(db)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(db, f"begin; select 1 from bookings where booking_id={booking} for update; select pg_sleep(.4); select 1 from slots where slot_id={target} for update; commit", blocker=True)
        wait_for_lock_holder(db)
        assert "PT409" in db(model_cancel(booking), success=False)
        first.result()
    assert json.loads(db(model_cancel(booking)))["replayed"] is False


def test_unknown_sibling_history_fails_closed(db):
    target, booking = prepare(db)
    db(f"insert into bookings(user_id,slot_id,status) values(101,{target},null)")
    assert "PT409" in db(model_cancel(booking), success=False)
    assert db("select status from slots") == "Ожидает подтверждения"


def test_concurrent_different_reasons_cannot_rewrite_cancellation(db):
    _, booking = prepare(db)
    assert "PT409" in race(db, model_cancel(booking), model_cancel(booking, "'other'"), True)
    assert db("select status || ':' || reason from bookings") == "Отменена моделью:time"
