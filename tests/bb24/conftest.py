"""Real PostgreSQL tests, always using a newly initialized local cluster.

Run from the repo root:
  python -m pip install -r tests/bb24/requirements.txt
  python -m pytest tests/bb24 --basetemp=work/bb24-pytest

No production DSN, .env, Supabase client, or external database is used. pgserver
supplies PostgreSQL binaries; independent psycopg connections exercise locks.
"""

from pathlib import Path
import shlex
import subprocess

import pgserver
import psycopg
from psycopg import sql
import pytest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = next((ROOT / "supabase/migrations").glob("*_bb24_atomic_booking.sql"))
BIN = Path(pgserver.__file__).parent / "pginstall/bin"


@pytest.fixture(scope="session")
def cluster(tmp_path_factory):
    root = tmp_path_factory.mktemp("postgres")
    data = root / "data"
    # Unix sockets have short path limits. Keep them in pytest's temporary root.
    socket = tmp_path_factory.getbasetemp() / "socket"
    socket.mkdir(mode=0o700)
    subprocess.run(
        [str(BIN / "initdb"), "-D", str(data), "-U", "postgres",
         "--auth=trust", "--no-locale", "--encoding=UTF8"],
        check=True, capture_output=True, text=True,
    )
    options = shlex.join([
        "-c", "listen_addresses=", "-c", f"unix_socket_directories={socket}",
        "-c", "port=55424", "-c", "fsync=off",
    ])
    subprocess.run(
        [str(BIN / "pg_ctl"), "-D", str(data), "-l", str(root / "postgres.log"),
         "-o", options, "-w", "start"],
        check=True, capture_output=True, text=True,
    )
    params = {"host": str(socket), "port": 55424, "user": "postgres"}
    try:
        with psycopg.connect(**params, dbname="postgres", autocommit=True) as conn:
            conn.execute("create role anon nologin")
            conn.execute("create role authenticated nologin")
            conn.execute("create role service_role nologin bypassrls")
        yield params
    finally:
        subprocess.run(
            [str(BIN / "pg_ctl"), "-D", str(data), "-m", "immediate", "-w", "stop"],
            check=True, capture_output=True, text=True,
        )


class TestDatabase:
    __test__ = False

    def __init__(self, params):
        self.params = params

    def connect(self, role=None, *, autocommit=True):
        conn = psycopg.connect(**self.params, autocommit=autocommit)
        conn.execute("set statement_timeout = '10s'")
        conn.execute("set lock_timeout = '5s'")
        if role:
            conn.execute(sql.SQL("set role {}").format(sql.Identifier(role)))
        return conn

    def book(self, user_id=101, slot_id=1):
        with self.connect("service_role") as conn:
            return conn.execute(
                "select public.bb24_book_slot(%s, %s)", (user_id, slot_id)
            ).fetchone()[0]


@pytest.fixture
def database_factory(cluster):
    names = []

    def create(*, migrate=True):
        name = f"bb24_test_{len(names)}"
        with psycopg.connect(**cluster, dbname="postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
        names.append(name)
        database = TestDatabase({**cluster, "dbname": name})
        with database.connect() as conn:
            conn.execute((Path(__file__).parent / "schema.sql").read_text())
            # Apply the actual existing public-table migration. Storage bucket
            # policies following this marker are unrelated to booking tests.
            baseline = (ROOT / "supabase/migrations/20260930_bb.sql").read_text()
            conn.execute(baseline.partition("insert into storage.buckets")[0])
            if migrate:
                conn.execute(MIGRATION.read_text())
            conn.execute("insert into users (user_id, name) values (101, 'A'), (102, 'B')")
            conn.execute("insert into masters (master_id, name) values (201, 'M')")
            conn.execute("insert into services (service_id, name) values (301, 'S')")
            conn.execute("""
                insert into slots (slot_id, master_id, service_id, date_time, status)
                values (1, 201, 301, clock_timestamp() + interval '1 day', 'Свободен')
            """)
        return database

    try:
        yield create
    finally:
        with psycopg.connect(**cluster, dbname="postgres", autocommit=True) as admin:
            for name in names:
                admin.execute(
                    sql.SQL("drop database {} with (force)").format(sql.Identifier(name))
                )


@pytest.fixture
def db(database_factory):
    return database_factory()
