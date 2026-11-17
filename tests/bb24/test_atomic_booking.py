from concurrent.futures import ThreadPoolExecutor
from queue import Queue
import time

import psycopg
import pytest

from conftest import MIGRATION


PENDING = "Ожидает подтверждения мастера"
WAITING = "Ожидает подтверждения"


def assert_error(db, code, message, *, user_id=101, slot_id=1):
    with pytest.raises(psycopg.Error) as error:
        db.book(user_id, slot_id)
    assert error.value.sqlstate == code
    assert error.value.diag.message_primary == message


def assert_state(db, count, status):
    with db.connect() as conn:
        assert conn.execute("select count(*) from bookings").fetchone()[0] == count
        assert conn.execute("select status from slots where slot_id = 1").fetchone()[0] == status


def add_booking(db, status, *, user_id=101, reason=None):
    with db.connect() as conn:
        return conn.execute(
            "insert into bookings (user_id, slot_id, status, reason) "
            "values (%s, 1, %s, %s) returning booking_id",
            (user_id, status, reason),
        ).fetchone()[0]


def wait_for_block(db, pid, blocker):
    deadline = time.monotonic() + 3
    with db.connect() as observer:
        while time.monotonic() < deadline:
            if blocker in observer.execute(
                "select pg_blocking_pids(%s)", (pid,)
            ).fetchone()[0]:
                return
            time.sleep(0.01)
    pytest.fail("Second independent connection did not wait for the slot lock")


def competing_booking(db, ready, user_id):
    with db.connect("service_role") as conn:
        ready.put(conn.info.backend_pid)
        try:
            return conn.execute(
                "select bb24_book_slot(%s, 1)", (user_id,)
            ).fetchone()[0]
        except psycopg.Error as error:
            return error.sqlstate, error.diag.message_primary


def test_success(db):
    result = db.book()
    assert result["replayed"] is False
    assert result["booking"]["booking_id"] > 0
    assert result["booking"]["user_id"] == 101
    assert result["booking"]["slot_id"] == 1
    assert result["booking"]["status"] == PENDING
    assert result["booking"]["reason"] is None
    assert_state(db, 1, WAITING)


def test_occupied_slot(db):
    db.book()
    assert_error(db, "PT409", "BB24_SLOT_UNAVAILABLE", user_id=102)
    assert_state(db, 1, WAITING)


@pytest.mark.parametrize("user_id", [101, 102])
def test_concurrent_bookings_lock_then_recheck(db, user_id):
    ready = Queue()
    with db.connect("service_role", autocommit=False) as first:
        result = first.execute("select bb24_book_slot(101, 1)").fetchone()[0]
        # First request has inserted and updated, but has not committed.
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(competing_booking, db, ready, user_id)
            try:
                wait_for_block(db, ready.get(timeout=3), first.info.backend_pid)
                assert not future.done()
                # No observer sees a partially committed booking/slot pair.
                assert_state(db, 0, "Свободен")
            finally:
                first.commit()
            second = future.result(timeout=6)
    if user_id == 101:
        assert second == {**result, "replayed": True}
    else:
        assert second == ("PT409", "BB24_SLOT_UNAVAILABLE")
    assert_state(db, 1, WAITING)


def test_waiter_can_book_after_first_request_rolls_back(db):
    ready = Queue()
    with db.connect("service_role", autocommit=False) as first:
        first.execute("select bb24_book_slot(101, 1)")
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(competing_booking, db, ready, 102)
            try:
                wait_for_block(db, ready.get(timeout=3), first.info.backend_pid)
            finally:
                first.rollback()
            assert future.result(timeout=6)["booking"]["user_id"] == 102
    assert_state(db, 1, WAITING)


def test_rechecks_actual_time_after_waiting_for_lock(db):
    ready = Queue()
    with db.connect(autocommit=False) as holder:
        holder.execute("select slot_id from slots where slot_id = 1 for update")
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(competing_booking, db, ready, 101)
            try:
                wait_for_block(db, ready.get(timeout=3), holder.info.backend_pid)
                # This is after the waiter's transaction began. now() in the
                # waiter would incorrectly accept this now-expired appointment.
                holder.execute("update slots set date_time = clock_timestamp() where slot_id = 1")
            finally:
                holder.commit()
            assert future.result(timeout=6) == ("PT409", "BB24_SLOT_EXPIRED")
    assert_state(db, 0, "Свободен")


def test_rechecks_time_after_waiting_for_user_lock(db):
    ready = Queue()
    with db.connect() as setup:
        setup.execute("update slots set date_time = clock_timestamp() + interval '0.5 seconds'")
    with db.connect(autocommit=False) as holder:
        holder.execute("select user_id from users where user_id = 101 for update")
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(competing_booking, db, ready, 101)
            try:
                wait_for_block(db, ready.get(timeout=3), holder.info.backend_pid)
                # The RPC already holds the slot lock and is now waiting for
                # the user lock. Let the appointment expire during that wait.
                with db.connect() as observer:
                    remaining = observer.execute(
                        "select greatest(0, extract(epoch from date_time - clock_timestamp())) "
                        "from slots where slot_id = 1"
                    ).fetchone()[0]
                time.sleep(float(remaining) + 0.02)
            finally:
                holder.rollback()
            assert future.result(timeout=6) == ("PT409", "BB24_SLOT_EXPIRED")
    assert_state(db, 0, "Свободен")


@pytest.mark.parametrize("confirmed", [False, True])
def test_same_user_retry_returns_original_booking(db, confirmed):
    first = db.book()
    if confirmed:
        with db.connect() as conn:
            conn.execute("update bookings set status = 'Активна'")
            conn.execute("update slots set status = 'Занят'")
        first["booking"]["status"] = "Активна"
    assert db.book() == {**first, "replayed": True}
    assert_state(db, 1, "Занят" if confirmed else WAITING)


def test_retry_after_appointment_time_still_returns_original(db):
    original = db.book()
    with db.connect() as conn:
        conn.execute("update slots set date_time = clock_timestamp() - interval '1 day'")
    assert db.book() == {**original, "replayed": True}
    assert_state(db, 1, WAITING)


def test_missing_slot(db):
    assert_error(db, "PT404", "BB24_SLOT_NOT_FOUND", slot_id=9999)
    assert_state(db, 0, "Свободен")


def test_missing_user(db):
    assert_error(db, "PT404", "BB24_USER_NOT_FOUND", user_id=9999)
    assert_state(db, 0, "Свободен")


def test_expired_free_slot(db):
    with db.connect() as conn:
        conn.execute("update slots set date_time = clock_timestamp() - interval '1 second'")
    assert_error(db, "PT409", "BB24_SLOT_EXPIRED")
    assert_state(db, 0, "Свободен")


def test_error_after_both_writes_rolls_back_everything(db):
    with db.connect() as conn:
        conn.execute("""
            create function public.fail_slot_update() returns trigger
            language plpgsql as $$
            begin
                if not exists (select 1 from public.bookings where slot_id = new.slot_id) then
                    raise exception 'test did not reach the booking insert';
                end if;
                raise exception 'injected failure after both writes';
            end $$;
            create trigger fail_update after update on slots
            for each row execute function public.fail_slot_update();
        """)
    assert_error(db, "P0001", "injected failure after both writes")
    assert_state(db, 0, "Свободен")
    with db.connect() as conn:
        conn.execute("drop trigger fail_update on slots")
    assert db.book()["replayed"] is False


@pytest.mark.parametrize("table, event", [("slots", "update"), ("bookings", "insert")])
def test_trigger_suppressing_a_write_cannot_report_success(db, table, event):
    with db.connect() as conn:
        # table/event come exclusively from this test's constant parameters.
        conn.execute(f"""
            create function public.suppress_write() returns trigger
            language plpgsql as $$ begin return null; end $$;
            create trigger suppress_write before {event} on {table}
            for each row execute function public.suppress_write();
        """)
    assert_error(db, "PT409", "BB24_INVALID_STATE")
    assert_state(db, 0, "Свободен")


@pytest.mark.parametrize("status", [WAITING, "Занят", "Отменен", "available", "", None, "future"])
def test_non_free_or_unknown_slot_status_is_rejected(db, status):
    with db.connect() as conn:
        conn.execute("update slots set status = %s", (status,))
    assert_error(db, "PT409", "BB24_SLOT_UNAVAILABLE")
    assert_state(db, 0, status)


@pytest.mark.parametrize("status", ["confirmed", "Выполнена", None, ""])
def test_unknown_booking_status_fails_closed_without_rewriting_history(db, status):
    add_booking(db, status)
    assert_error(db, "PT409", "BB24_INVALID_STATE")
    assert_state(db, 1, "Свободен")
    with db.connect() as conn:
        assert conn.execute("select status from bookings").fetchone()[0] == status


@pytest.mark.parametrize("booking_status, slot_status", [
    (PENDING, "Свободен"), ("Активна", WAITING), (PENDING, None), (PENDING, "Отменен")
])
def test_inconsistent_pair_is_not_replayed_or_repaired(db, booking_status, slot_status):
    add_booking(db, booking_status)
    with db.connect() as conn:
        conn.execute("update slots set status = %s", (slot_status,))
    assert_error(db, "PT409", "BB24_INVALID_STATE")
    assert_state(db, 1, slot_status)


@pytest.mark.parametrize("column", ["master_id", "service_id"])
def test_incomplete_slot_is_rejected(db, column):
    with db.connect() as conn:
        conn.execute(f"update slots set {column} = null")
    assert_error(db, "PT409", "BB24_INVALID_STATE")
    assert_state(db, 0, "Свободен")


def test_master_rejection_blocks_only_rejected_model(db):
    history_id = add_booking(db, "Отменена мастером", reason="model")
    assert_error(db, "PT403", "BB24_MODEL_REJECTED")
    assert db.book(user_id=102)["booking"]["user_id"] == 102
    assert_state(db, 2, WAITING)
    with db.connect() as conn:
        assert conn.execute(
            "select status, reason from bookings where booking_id = %s", (history_id,)
        ).fetchone() == ("Отменена мастером", "model")


@pytest.mark.parametrize("status, reason", [
    ("Отменена моделью", "time"), ("Отменена мастером", "plans")
])
def test_history_is_preserved_and_does_not_prevent_a_new_booking(db, status, reason):
    history_id = add_booking(db, status, reason=reason)
    result = db.book()
    assert result["replayed"] is False
    assert result["booking"]["booking_id"] != history_id
    assert_state(db, 2, WAITING)


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_public_roles_cannot_execute_even_with_spoofed_identity(db, role):
    with db.connect(role) as conn:
        assert conn.execute(
            "select has_function_privilege(current_user, 'bb24_book_slot(bigint,bigint)', 'execute')"
        ).fetchone()[0] is False
        # request.jwt.claims does not change the database caller's privileges.
        conn.execute("set request.jwt.claims = '{\"role\":\"service_role\",\"sub\":\"101\"}'")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select bb24_book_slot(101, 1)")
    assert_state(db, 0, "Свободен")


def test_public_default_execute_is_revoked_and_invoker_is_used(db):
    with db.connect() as conn:
        assert conn.execute("""
            select p.prosecdef, p.proconfig,
                exists (select 1 from aclexplode(p.proacl) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE')
            from pg_proc p where p.oid = 'bb24_book_slot(bigint,bigint)'::regprocedure
        """).fetchone() == (False, ['search_path=""'], False)
        conn.execute("create role bb24_untrusted nologin")
    try:
        with db.connect("bb24_untrusted") as conn:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute("select public.bb24_book_slot(101, 1)")
    finally:
        with db.connect() as conn:
            conn.execute("drop role bb24_untrusted")


def test_server_rpc_works_with_tables_closed_and_rls_enabled(db):
    with db.connect() as conn:
        conn.execute("""
            revoke all on users, masters, services, slots, bookings from anon, authenticated;
            alter table users enable row level security;
            alter table slots enable row level security;
            alter table bookings enable row level security;
        """)
    assert db.book()["replayed"] is False
    assert_state(db, 1, WAITING)


def test_unique_index_protects_non_rpc_writers(db):
    db.book()
    with db.connect() as conn:
        with pytest.raises(psycopg.errors.UniqueViolation) as error:
            conn.execute(
                "insert into bookings (user_id, slot_id, status) values (102, 1, 'Активна')"
            )
        assert error.value.diag.constraint_name == "bookings_one_live_booking_per_slot"
    assert_state(db, 1, WAITING)


def test_migration_refuses_duplicates_without_deleting_history(database_factory):
    db = database_factory(migrate=False)
    with db.connect() as conn:
        conn.execute("drop index bookings_one_live_booking_per_slot")
    add_booking(db, PENDING)
    add_booking(db, "Активна", user_id=102)
    with db.connect() as conn:
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(MIGRATION.read_text())
        conn.execute("rollback")
        assert conn.execute("select to_regprocedure('bb24_book_slot(bigint,bigint)')").fetchone()[0] is None
    assert_state(db, 2, "Свободен")


@pytest.mark.parametrize("user_id, slot_id", [(None, 1), (101, None), (0, 1), (-1, 1), (101, 0)])
def test_invalid_arguments_do_not_write(db, user_id, slot_id):
    assert_error(db, "PT422", "BB24_INVALID_ARGUMENT", user_id=user_id, slot_id=slot_id)
    assert_state(db, 0, "Свободен")
