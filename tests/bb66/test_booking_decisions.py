"""BB-66 in a disposable local PostgreSQL cluster, with real migrations."""
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from tests.bb63.test_slots_write import cluster, db, slot, wait_for_lock_holder
from tests.bb64.test_slot_cancel import race, cancel


def prepare(db):
    target = slot(db)
    booking = json.loads(db(f"select bb24_book_slot(101,{target})"))["booking"]
    return target, booking["booking_id"]


def decide(booking, action="confirm", reason="null", master=201):
    return f"select bb66_decide_booking({master},{booking},'{action}',{reason})"


@pytest.mark.parametrize("action,reason,bs,ss", [
    ("confirm", "null", "Активна", "Занят"),
    ("reject", "'model'", "Отменена мастером", "Свободен"),
    ("reject", "'plans'", "Отменена мастером", "Отменен"),
])
def test_decision_owner_acl_retry_and_rejection_history(db, action, reason, bs, ss):
    target, booking = prepare(db)
    for actor in [101, 202]:
        assert "PT404" in db(decide(booking, action, reason, actor), success=False)
    assert "PT404" in db(decide(99999), success=False)
    for role in ["anon", "authenticated"]:
        assert "42501" in db(f"set role {role}; " + decide(booking), success=False)
    query = "set role service_role; " + decide(booking, action, reason)
    result = json.loads(db(query))
    assert result["replayed"] is False
    assert result["booking"]["status"] == bs
    assert db("select status from slots") == ss
    assert json.loads(db(query)) == {**result, "replayed": True}
    if reason == "'model'":
        assert "PT403" in db(f"select bb24_book_slot(101,{target})", success=False)
        db("insert into users(user_id,name) values(102,'Other')")
        db(f"select bb24_book_slot(102,{target})")
        assert "PT409" in db(query, success=False)
        assert db("select status from slots") == "Ожидает подтверждения"


@pytest.mark.parametrize("bs,ss,reason", [
    ("Отменена моделью", "Свободен", "time"),
    ("Отменена мастером", "Отменен", "plans"),
    ("Активна", "Ожидает подтверждения", None),
    ("Ожидает подтверждения мастера", "Свободен", None),
    ("Ожидает подтверждения мастера", "Занят", None),
    (None, "Ожидает подтверждения", None),
    ("confirmed", "Ожидает подтверждения", None),
])
def test_inconsistent_or_cancelled_never_confirms(db, bs, ss, reason):
    _, booking = prepare(db)
    lit = lambda v: "null" if v is None else "'" + v + "'"
    db(f"update bookings set status={lit(bs)},reason={lit(reason)}; update slots set status='{ss}'")
    assert "PT409" in db(decide(booking), success=False)
    assert db("select status from slots") == ss


@pytest.mark.parametrize("args", ["0,1,'confirm',null", "201,0,'confirm',null", "201,1,'cancel',null", "201,1,'reject',null", "201,1,'reject','time'", "201,1,'confirm','plans'"])
def test_invalid_arguments(db, args):
    assert "PT422" in db(f"select bb66_decide_booking({args})", success=False)


@pytest.mark.parametrize("table", ["bookings", "slots"])
@pytest.mark.parametrize("failure", ["raise", "skip", "rewrite"])
def test_sql_errors_and_suppressed_or_rewritten_updates_roll_back(db, table, failure):
    _, booking = prepare(db)
    body = {"raise": "raise exception 'injected failure';", "skip": "return null;", "rewrite": "new.status := 'unexpected'; return new;"}[failure]
    db(f"create function fail_write() returns trigger language plpgsql as $$ begin {body} end $$; create trigger fail_write before update on {table} for each row execute function fail_write()")
    assert ("injected failure" if failure == "raise" else "PT409") in db(decide(booking), success=False)
    assert db("select status from bookings") == "Ожидает подтверждения мастера"
    assert db("select status from slots") == "Ожидает подтверждения"
    assert db("select reason is null from bookings") == "t"


@pytest.mark.parametrize("operation", ["confirm", "model", "plans"])
def test_concurrent_duplicate_only_one_changed_result(db, operation):
    _, booking = prepare(db)
    query = decide(booking) if operation == "confirm" else decide(booking, "reject", f"'{operation}'")
    assert json.loads(race(db, query, query))["replayed"] is True


@pytest.mark.parametrize("operation", ["confirm", "model", "plans"])
@pytest.mark.parametrize("cancel_first", [False, True])
def test_race_with_slot_cancel(db, operation, cancel_first):
    target, booking = prepare(db)
    query = decide(booking) if operation == "confirm" else decide(booking, "reject", f"'{operation}'")
    first, second = (cancel(target), query) if cancel_first else (query, cancel(target))
    history_conflict = operation == "model" and not cancel_first
    fails = (cancel_first and operation != "plans") or history_conflict
    result = race(db, first, second, fails)
    if fails:
        assert "PT409" in result
    assert db("select count(*) from slots") == "1"
    assert db("select count(*) from bookings") == "1"
    if history_conflict:
        assert 'BB73_SLOT_HAS_HISTORY' in result
        assert db("select status from slots") == 'Свободен'
        assert db("select status || ':' || reason from bookings") == 'Отменена мастером:model'
    else:
        assert db("select status from slots") == "Отменен"
        assert db("select status || ':' || reason from bookings") == "Отменена мастером:plans"


def test_reverse_lock_writer_conflicts_without_deadlock(db):
    target, booking = prepare(db)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(db, f"begin; select 1 from bookings where booking_id={booking} for update; select pg_sleep(.4); select 1 from slots where slot_id={target} for update; commit", blocker=True)
        wait_for_lock_holder(db)
        assert "PT409" in db(decide(booking), success=False)
        first.result()
    assert json.loads(db(decide(booking)))["replayed"] is False


def test_expired_confirmation_conflicts_but_rejection_allowed(db):
    _, booking = prepare(db)
    db("update slots set date_time=clock_timestamp()-interval '1 hour'")
    assert "PT409" in db(decide(booking), success=False)
    assert json.loads(db(decide(booking, "reject", "'plans'")))["replayed"] is False


@pytest.mark.parametrize("first,second", [("confirm", "model"), ("model", "confirm"), ("plans", "model"), ("model", "plans")])
def test_conflicting_decisions_preserve_the_winner(db, first, second):
    _, booking = prepare(db)
    query = lambda action: decide(booking) if action == "confirm" else decide(booking, "reject", f"'{action}'")
    assert "PT409" in race(db, query(first), query(second), True)
    assert db("select status from slots") == {"confirm": "Занят", "model": "Свободен", "plans": "Отменен"}[first]


def test_hidden_rejected_model_read_rule_is_preserved():
    from pathlib import Path
    source = Path('supabase/functions/slots-read/repository.ts').read_text()
    assert "Отменена мастером" in source and "model" in source
