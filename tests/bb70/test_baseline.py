"""Empty database -> every real migration -> opt-in seed; no external DSN.

Uses existing PostgreSQL binaries and the disposable unix-socket cluster from
BB-63. Storage is a separate metadata fixture, NOT a Supabase API simulation.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

import pytest

from tests.bb63.test_slots_write import BIN, cluster  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / "supabase/migrations").glob("*.sql"))
TABLES = ("users", "masters", "services", "slots", "bookings", "telegram_webhook_updates", "slot_photos")


@pytest.fixture(params=[False, True], ids=["plain-acl", "supabase-like-default-acl"])
def database(cluster, request):
    name = "bb70_" + uuid.uuid4().hex
    # Explicit socket, database, user, port; ignore libpq configuration from env.
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}

    def execute(query, *, dbname=name, success=True):
        result = subprocess.run(
            [str(BIN / "psql"), "-XqAt", "-v", "ON_ERROR_STOP=1",
             "-v", "VERBOSITY=verbose", "-h", str(cluster), "-p", "55463",
             "-U", "postgres", "-d", dbname],
            input=query, text=True, capture_output=True, timeout=20, env=env,
        )
        if success:
            assert result.returncode == 0, result.stderr
            return result.stdout.strip()
        assert result.returncode != 0, result.stdout
        return result.stderr

    execute(f"create database {name}", dbname="postgres")
    try:
        execute("""
            do $$ begin
                if not exists (select 1 from pg_roles where rolname='anon') then
                    create role anon nologin;
                    create role authenticated nologin;
                    create role service_role nologin bypassrls;
                end if;
            end $$;
        """)
        assert execute("select count(*) from pg_tables where schemaname='public'") == "0"
        execute((Path(__file__).parent / "storage_fixture.sql").read_text())
        if request.param:
            # Adversarial platform-like defaults must be removed by migrations.
            execute("""
                alter default privileges in schema public grant all on tables to anon, authenticated;
                alter default privileges in schema public grant all on sequences to anon, authenticated;
                alter default privileges in schema public grant execute on functions to anon, authenticated;
            """)
        for migration in MIGRATIONS:
            execute(migration.read_text())
        yield execute
    finally:
        execute(f"drop database {name} with (force)", dbname="postgres")


def test_cli_names_and_order():
    # CLI's actual rule accepts digit versions of any length (see README).
    assert all(re.fullmatch(r"([0-9]+)_(.*)\.sql", p.name) for p in MIGRATIONS)
    versions = [p.name.split("_", 1)[0] for p in MIGRATIONS]
    assert len(versions) == len(set(versions))
    assert [p.name.split("_", 1)[1] for p in MIGRATIONS] == [
        "bb70_database_baseline.sql", "bb.sql", "bb01_restrict_public_core_tables.sql",
        "bb03_lock_master_avatar_writes.sql", "telegram_webhook_updates.sql",
        "bb24_atomic_booking.sql", "bb63_slots_write.sql", "bb64_slot_cancel.sql",
        "bb66_booking_decisions.sql", "bb67_model_cancel.sql", "bb73_preserve_booking_history.sql",
        "bb73_preserve_parent_history.sql", "slot_work_photos.sql",
    ]


def test_empty_schema_metadata_and_acl(database):
    db = database
    assert db("select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public'") == ",".join(sorted(TABLES))
    for table in TABLES:
        assert db(f"select count(*) from public.{table}") == "0"
        assert db(f"select relrowsecurity from pg_class where oid='public.{table}'::regclass") == "t"
        for permission in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert db(f"select has_table_privilege('service_role','public.{table}','{permission}')") == "t"
        for role in ("anon", "authenticated"):
            assert db(f"select has_table_privilege('{role}','public.{table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege('{role}','public.{table}','SELECT,INSERT,UPDATE,REFERENCES')") == "f"
            for statement in (f"select * from {table}", f"insert into {table} default values", f"delete from {table}"):
                assert "42501" in db(f"set role {role}; {statement}", success=False)
    assert db("select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='p'") == "7"
    assert db("select string_agg(conname || ':' || confdeltype::text, ',' order by conname) from pg_constraint where connamespace='public'::regnamespace and contype='f'") == "bookings_slot_id_fkey:r,bookings_user_id_fkey:r,slot_photos_slot_id_fkey:n,slots_master_id_fkey:r,slots_service_id_fkey:r"
    assert db("select count(*) from pg_policy where polrelid in (select oid from pg_class where relnamespace='public'::regnamespace)") == "0"
    columns = json.loads(db("""
        select json_object_agg(table_name || '.' || column_name,
            json_build_array(data_type, is_nullable, identity_generation, column_default))
        from information_schema.columns where table_schema='public'
        and table_name not in ('telegram_webhook_updates','slot_photos')
    """))
    expected_columns = {
        "users": "user_id name phone_number",
        "masters": "master_id name phone_number address avatar_url",
        "services": "service_id name description",
        "slots": "slot_id date_time status master_id service_id city address description",
        "bookings": "booking_id user_id slot_id status reason",
    }
    assert set(columns) == {f"{t}.{c}" for t, names in expected_columns.items() for c in names.split()}
    for key, (kind, nullable, identity, default) in columns.items():
        table, column = key.split(".")
        pk = column == {"users": "user_id", "masters": "master_id", "services": "service_id", "slots": "slot_id", "bookings": "booking_id"}[table]
        assert kind == ("bigint" if column.endswith("_id") else "timestamp with time zone" if column == "date_time" else "text")
        assert nullable == ("NO" if pk or column in ("name", "date_time") else "YES")
        assert identity == ("BY DEFAULT" if pk and table in ("services", "slots", "bookings") else None)
        assert default == ({"slots.status": "'available'::text", "bookings.status": "'confirmed'::text"}.get(key))
    for table, column in (("services", "service_id"), ("slots", "slot_id"), ("bookings", "booking_id")):
        sequence = f"public.{table}_{column}_seq"
        assert db(f"select has_sequence_privilege('service_role','{sequence}','USAGE')") == "t"
        for role in ("anon", "authenticated"):
            assert db(f"select has_sequence_privilege('{role}','{sequence}','SELECT,USAGE,UPDATE')") == "f"
    for index in ("bookings_one_live_booking_per_slot", "slots_one_live_time_per_master", "slots_city_idx", "bookings_user_idx", "slots_master_date_idx"):
        assert db(f"select indisvalid from pg_index where indexrelid='public.{index}'::regclass") == "t"
    for index in ("bookings_one_live_booking_per_slot", "slots_one_live_time_per_master"):
        assert db(f"select indisunique and indpred is not null from pg_index where indexrelid='public.{index}'::regclass") == "t"
    assert db("select count(*) from pg_proc where pronamespace='public'::regnamespace") == "14"
    assert db("select bool_and(not prosecdef and has_function_privilege('service_role',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE') and not has_function_privilege('authenticated',oid,'EXECUTE')) from pg_proc where pronamespace='public'::regnamespace") == "t"


def test_seed_profiles_and_booking_lifecycle(database):
    db = database
    db("set role service_role; " + (ROOT / "supabase/seeds/test_catalog.sql").read_text())
    services = json.loads(db("set role service_role; select json_agg(s order by service_id) from (select service_id,name,description from services) s"))
    assert len(services) == 3
    assert all(s["service_id"] > 0 and s["name"].startswith("[ТЕСТ BB-70]") for s in services)
    db("""set role service_role;
        insert into users(user_id,name) values(101,'Test user') on conflict(user_id) do nothing;
        update users set name='Edited', phone_number='+70000000000' where user_id=101;
        insert into users(user_id,name) values(101,'Telegram') on conflict(user_id) do nothing;
        insert into masters(master_id,name) values(201,'Test master') on conflict(master_id) do nothing;
        update masters set name='Edited master',address='Test address',avatar_url='https://example.test/avatar.png' where master_id=201;
        insert into masters(master_id,name) values(201,'Telegram') on conflict(master_id) do nothing;
    """)
    assert db("set role service_role; select name || ':' || phone_number from users where user_id=101") == "Edited:+70000000000"
    assert db("set role service_role; select name || ':' || address || ':' || avatar_url from masters where master_id=201") == "Edited master:Test address:https://example.test/avatar.png"

    def rpc(query):
        return json.loads(db("set role service_role; select " + query))

    for offset, service in enumerate(services):
        slot = rpc(f"bb63_create_slot(201,{service['service_id']},clock_timestamp()+interval '{offset+1} days','Тестовый город','Тестовый адрес','Тестовый слот')")
        sid = slot["slot_id"]
        assert slot["status"] == "Свободен"
        first = rpc(f"bb24_book_slot(101,{sid})")
        bid = first["booking"]["booking_id"]
        assert first["replayed"] is False
        assert rpc(f"bb24_book_slot(101,{sid})")["replayed"] is True
        # Relationship joins used by slots-read, bookings-read and notifications.
        assert db(f"set role service_role; select count(*) from bookings b join slots s using(slot_id) join masters m using(master_id) join services v using(service_id) join users u using(user_id) where b.booking_id={bid}") == "1"
        if offset == 0:
            assert rpc(f"bb66_decide_booking(201,{bid},'confirm',null)")["booking"]["status"] == "Активна"
            assert rpc(f"bb67_cancel_booking(101,{bid},'time')")["booking"]["status"] == "Отменена моделью"
            assert 'BB73_SLOT_HAS_HISTORY' in db(f"set role service_role; select bb63_delete_slot(201,{sid})", success=False)
            assert db(f"select count(*) from bookings where booking_id={bid}") == "1"
        elif offset == 1:
            assert rpc(f"bb64_cancel_slot(201,{sid})")["booking"]["reason"] == "plans"
        else:
            assert rpc(f"bb66_decide_booking(201,{bid},'reject','model')")["booking"]["reason"] == "model"
            assert "PT403" in db(f"set role service_role; select bb24_book_slot(101,{sid})", success=False)
    # Identity insertion remains usable after the seed; no manually assigned IDs.
    assert int(db("set role service_role; insert into services(name) values('[ТЕСТ] extra') returning service_id")) > max(s["service_id"] for s in services)
    owner = "00000000-0000-4000-8000-000000000001"
    assert db(f"set role service_role; select telegram_webhook_claim(900,1,'{owner}')") == "acquired"
    assert db(f"set role service_role; select telegram_webhook_begin_send(900,1,'{owner}'); select telegram_webhook_complete(900,1,'{owner}')") == "t\nt"


def test_storage_metadata_fixture_only(database):
    db = database
    assert db("select public::text || ':' || file_size_limit from storage.buckets where id='master-avatars'") == "true:5242880"
    assert db("select allowed_mime_types::text from storage.buckets where id='master-avatars'") == "{image/jpeg,image/png,image/webp}"
    db("insert into storage.objects values(1,'master-avatars')")
    # Even a broad permissive policy cannot bypass BB-03's restrictive guards.
    db("create policy fixture_broad_write on storage.objects for all to public using(true) with check(true)")
    for role in ("anon", "authenticated"):
        assert db(f"set role {role}; select count(*) from storage.objects") == "1"
        assert "42501" in db(f"set role {role}; insert into storage.objects values(2,'master-avatars')", success=False)
        assert db(f"set role {role}; with changed as (update storage.objects set id=2 returning *) select count(*) from changed") == "0"
        assert db(f"set role {role}; with changed as (delete from storage.objects returning *) select count(*) from changed") == "0"
