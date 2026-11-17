"""BB-63 on a fresh, disposable PostgreSQL cluster; no DSN or .env is read.

Run: python3 -m pytest tests/bb63 -q
Uses existing PostgreSQL binaries (PATH or Homebrew); no Python DB driver needed.
"""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import uuid
import os
import shutil
import subprocess
import time

import pytest

ROOT = Path(__file__).resolve().parents[2]
BIN = Path(
    shutil.which("initdb") or "/opt/homebrew/opt/postgresql@18/bin/initdb"
).parent


@pytest.fixture(scope="module")
def cluster(tmp_path_factory):
    if not (BIN / "initdb").is_file():
        pytest.skip("PostgreSQL initdb is unavailable")
    directory = tmp_path_factory.mktemp("bb63")
    socket = directory / "s"
    socket.mkdir()
    data = directory / "data"
    subprocess.run(
        [
            str(BIN / "initdb"),
            "-D",
            str(data),
            "-U",
            "postgres",
            "--auth=trust",
            "--no-locale",
            "--encoding=UTF8",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            str(BIN / "pg_ctl"),
            "-D",
            str(data),
            "-l",
            str(directory / "log"),
            "-o",
            f"-c listen_addresses='' -c unix_socket_directories={socket} -p 55463",
            "-w",
            "start",
        ],
        check=True,
        capture_output=True,
    )
    try:
        yield socket
    finally:
        subprocess.run(
            [str(BIN / "pg_ctl"), "-D", str(data), "-m", "immediate", "-w", "stop"],
            check=True,
            capture_output=True,
        )


@pytest.fixture
def db(cluster, request):
    name = "bb63_" + uuid.uuid4().hex
    env = {**os.environ, "PGAPPNAME": "bb63-test"}

    def execute(sql, *, database=name, success=True, blocker=False):
        result = subprocess.run(
            [
                str(BIN / "psql"),
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-v",
                "VERBOSITY=verbose",
                "-h",
                str(cluster),
                "-p",
                "55463",
                "-U",
                "postgres",
                "-d",
                database,
            ],
            input=sql,
            text=True,
            capture_output=True,
            timeout=15,
            env={**env, "PGAPPNAME": "bb63-test-blocker" if blocker else "bb63-test"},
        )
        if success:
            assert result.returncode == 0, result.stderr
            return result.stdout.strip()
        assert result.returncode != 0, result.stdout
        return result.stderr

    execute(f"create database {name}", database="postgres")
    execute(
        """
        do $$ begin
            if not exists (select 1 from pg_roles where rolname='anon') then
                create role anon nologin;
                create role authenticated nologin;
                create role service_role nologin bypassrls;
            end if;
        end $$;
    """
    )
    execute((ROOT / "tests/bb70/storage_fixture.sql").read_text())
    for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
        execute(migration.read_text())
    execute(
        """
        insert into masters(master_id,name) values (201,'M'),(202,'Other');
        insert into users(user_id,name) values (101,'U');
        insert into services(service_id,name) values (301,'S'),(302,'Other');
    """
    )
    yield execute
    execute(f"drop database {name} with (force)", database="postgres")


def create(
    *,
    master=201,
    service=301,
    date="'2035-01-01T12:00:00Z'",
    city="'Москва'",
    address="''",
    description="''",
):
    return f"select bb63_create_slot({master},{service},{date},{city},{address},{description})"


def slot(db):
    return json.loads(db("set role service_role; " + create()))["slot_id"]


def wait_for_lock_holder(db):
    for _ in range(100):
        if (
            db(
                "select count(*) from pg_stat_activity where application_name='bb63-test-blocker' and wait_event='PgSleep'"
            )
            == "1"
        ):
            return
        time.sleep(0.01)
    pytest.fail("blocker did not acquire lock")


def test_create_shape_schema_and_duplicate_instants(db):
    row = json.loads(db("set role service_role; " + create()))
    assert row["master_id"] == 201 and row["status"] == "Свободен"
    assert row["service_id"] == 301 and row["city"] == "Москва"
    assert row["address"] == row["description"] == ""
    failure = db(create(service=302, date="'2035-01-01T15:00:00+03:00'"), success=False)
    assert "23505" in failure and "slots_one_live_time_per_master" in failure
    assert json.loads(db(create(master=202)))["master_id"] == 202
    db(f"update slots set status='Отменен' where slot_id={row['slot_id']}")
    assert json.loads(db(create()))["status"] == "Свободен"


@pytest.mark.parametrize(
    "arguments,code",
    [
        ({"master": 999}, "PT404"),
        ({"service": 999}, "PT422"),
        ({"master": 0}, "PT422"),
        ({"date": "'2000-01-01Z'"}, "PT410"),
        ({"date": "clock_timestamp()"}, "PT410"),
        ({"date": "'infinity'"}, "PT422"),
        ({"date": "null"}, "PT422"),
        ({"city": "' '"}, "PT422"),
        ({"city": "repeat('x',201)"}, "PT422"),
        ({"address": "repeat('x',501)"}, "PT422"),
        ({"description": "repeat('x',2001)"}, "PT422"),
    ],
)
def test_invalid_create_has_no_side_effect(db, arguments, code):
    assert code in db("set role service_role; " + create(**arguments), success=False)
    assert db("select count(*) from slots") == "0"


def test_delete_requires_own_free_slot_and_valid_booking_state(db):
    identifier = slot(db)
    assert "PT404" in db(f"select bb63_delete_slot(202,{identifier})", success=False)
    assert "PT404" in db("select bb63_delete_slot(201,999)", success=False)
    for status in [
        "'Занят'",
        "'Ожидает подтверждения'",
        "'Отменен'",
        "'available'",
        "null",
    ]:
        db(f"update slots set status={status}")
        assert "PT409" in db(
            f"select bb63_delete_slot(201,{identifier})", success=False
        )
    db("update slots set status='Свободен'")
    for status in [
        "'Активна'",
        "'Ожидает подтверждения мастера'",
        "'confirmed'",
        "null",
    ]:
        db(
            f"insert into bookings(user_id,slot_id,status) values (101,{identifier},{status})"
        )
        assert "PT409" in db(
            f"select bb63_delete_slot(201,{identifier})", success=False
        )
        assert db("select count(*) from slots") == "1"
        db("delete from bookings")
    assert (
        db(f"set role service_role; select bb63_delete_slot(201,{identifier})") == "t"
    )
    assert db("select count(*) from slots") == "0"


def test_server_only_rpc_acl_and_table_protection(db):
    for role in ["anon", "authenticated"]:
        for query in [
            create(),
            "select bb63_delete_slot(201,1)",
            "insert into slots(date_time) values(now())",
            "delete from slots",
        ]:
            assert "42501" in db(f"set role {role}; {query}", success=False)


def test_concurrent_creates_have_one_winner(db):
    with ThreadPoolExecutor() as pool:
        first = pool.submit(
            db,
            "begin; set role service_role; "
            + create()
            + "; select pg_sleep(.5); commit",
            blocker=True,
        )
        wait_for_lock_holder(db)
        failure = db("set role service_role; " + create(service=302), success=False)
        first.result()
    assert "23505" in failure
    assert db("select count(*) from slots") == "1"


@pytest.mark.parametrize("winner", ["booking", "deletion"])
def test_booking_delete_race_uses_bb24_lock_order(db, winner):
    identifier = slot(db)
    book = f"select bb24_book_slot(101,{identifier})"
    delete = f"select bb63_delete_slot(201,{identifier})"
    first_query, second_query = (
        (book, delete) if winner == "booking" else (delete, book)
    )
    with ThreadPoolExecutor() as pool:
        first = pool.submit(
            db,
            "begin; set role service_role; "
            + first_query
            + "; select pg_sleep(.5); commit",
            blocker=True,
        )
        wait_for_lock_holder(db)
        failure = db("set role service_role; " + second_query, success=False)
        first.result()
    assert ("PT409" if winner == "booking" else "PT404") in failure
    assert db("select count(*) from bookings") == ("1" if winner == "booking" else "0")
    assert db("select count(*) from slots") == ("1" if winner == "booking" else "0")


def test_expiration_after_waiting_on_master_lock(db):
    instant = db("select clock_timestamp() + interval '.3 seconds'")
    with ThreadPoolExecutor() as pool:
        first = pool.submit(
            db,
            "begin; select master_id from masters where master_id=201 for update; select pg_sleep(.6); commit",
            blocker=True,
        )
        wait_for_lock_holder(db)
        failure = db(create(date=f"'{instant}'"), success=False)
        first.result()
    assert "PT410" in failure
    assert db("select count(*) from slots") == "0"


def test_expiration_after_waiting_on_unique_index(db):
    instant = db("select clock_timestamp() + interval '.3 seconds'")
    query = create(date=f"'{instant}'")
    with ThreadPoolExecutor() as pool:
        first = pool.submit(
            db,
            "begin; " + query + "; select pg_sleep(.6); delete from slots; commit",
            blocker=True,
        )
        wait_for_lock_holder(db)
        failure = db(query, success=False)
        first.result()
    assert "PT410" in failure
    assert db("select count(*) from slots") == "0"
