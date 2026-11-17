"""Restore fictional SQL and keep the audited preflight strict on PostgreSQL 18.

Socket-only PostgreSQL. Storage here is a stand-in; managed Storage is exercised
separately by tests/bb73/rehearse_existing_supabase.py. Never loads a DSN or .env.
"""
import hashlib
import shutil
import subprocess
import sys

from tests.bb63.test_slots_write import BIN, ROOT, cluster

sys.path.insert(0, str(ROOT / 'scripts'))
from prepare_existing_upgrade import prepare


def test_dump_restore_rejects_unreviewed_pg18_constraint_catalog(cluster, tmp_path):
    conn = ['-h', str(cluster), '-p', '55463', '-U', 'postgres']

    def call(tool, *args, sql=None):
        result = subprocess.run([str(BIN / tool), *conn, *args], input=sql,
                                text=True, capture_output=True)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def sql(database, statement):
        return call('psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', database, sql=statement)

    sql('postgres', """do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then
            create role anon; create role authenticated; create role service_role bypassrls;
        end if;
    end $$""")
    package = prepare()
    try:
        for database in ('bb76_source', 'bb76_restored'):
            call('createdb', database)
        sql('bb76_source', (ROOT / 'tests/bb70/storage_fixture.sql').read_text())
        sql('bb76_source', (package / 'local-fixture.sql').read_text())
        sql('bb76_source', """
            create schema auth;
            create table auth.users(id text primary key, metadata jsonb);
            insert into auth.users values('fictional-auth', '{"fixture":true}');
            insert into users(user_id,name) values(101,'Fake model');
            insert into masters(master_id,name) values(201,'Fake master');
            insert into services(name) values('Fake service');
            insert into slots(date_time,status,master_id,service_id)
                values('2025-01-01T12:00:00Z','Занят',201,1);
            insert into bookings(user_id,slot_id,status) values(101,1,'Активна');
        """)
        snapshot = """select jsonb_build_object(
            'users',(select jsonb_agg(t) from users t),
            'masters',(select jsonb_agg(t) from masters t),
            'services',(select jsonb_agg(t) from services t),
            'slots',(select jsonb_agg(t) from slots t),
            'bookings',(select jsonb_agg(t) from bookings t),
            'auth',(select jsonb_agg(t) from auth.users t),
            'sequences',(select jsonb_agg(t order by sequencename) from pg_sequences t
                         where schemaname='public'))"""
        before = sql('bb76_source', snapshot)
        dump = tmp_path / 'fictional.dump'
        call('pg_dump', '-d', 'bb76_source', '-Fc', '-f', str(dump))
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        call('pg_restore', '-d', 'bb76_restored', '--exit-on-error', '--single-transaction', str(dump))
        assert sql('bb76_restored', snapshot) == before
        # PG18 represents NOT NULL as pg_constraint rows. The audited PG17
        # catalog does not. Do not filter these away to make preflight pass.
        major = int(sql('bb76_restored', 'show server_version_num')) // 10000
        assert major >= 18, 'This regression targets the PostgreSQL 18 restore mismatch'
        result = subprocess.run([str(BIN / 'psql'), *conn, '-XqAt', '-v',
                                 'ON_ERROR_STOP=1', '-d', 'bb76_restored'],
                                input=(package / '00_preflight.sql').read_text(),
                                text=True, capture_output=True)
        assert result.returncode != 0
        assert 'constraint drift' in result.stderr
        assert sql('bb76_restored', snapshot) == before
        assert hashlib.sha256(dump.read_bytes()).hexdigest() == digest
        assert sql('bb76_restored', "select count(*) from pg_proc where pronamespace='public'::regnamespace") == '0'
        assert sql('bb76_restored', "select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f' and confdeltype='c'") == '4'
    finally:
        for database in ('bb76_source', 'bb76_restored'):
            call('dropdb', '--if-exists', database)
        shutil.rmtree(package)
