"""Fictional PostgreSQL 17 dump/restore + exact upgrade in guarded local Supabase.

Uses separate temporary databases with stand-in Storage/Auth schemas, not the
managed database. Full managed backup recovery still requires separate approval.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/bb72'))
sys.path.insert(0, str(ROOT / 'scripts'))
from local_probe import Probe
from prepare_existing_upgrade import prepare, SELECTED


def run(directory):
    p = Probe(directory)
    assert int(p.sql('show server_version_num')) // 10000 == 17
    names = ['bb76_' + uuid.uuid4().hex for _ in range(2)]
    package = prepare()

    def sql(database, text):
        return p.command('docker', 'exec', '-i', p.db, 'psql', '-XqAt',
                         '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, data=text)

    try:
        for name in names:
            p.sql('create database ' + name)
        sql(names[0], (ROOT / 'tests/bb70/storage_fixture.sql').read_text())
        sql(names[0], (package / 'local-fixture.sql').read_text())
        sql(names[0], """create schema auth;
            create table auth.users(id text primary key, metadata jsonb);
            insert into auth.users values('fictional', '{"fixture":true}');
            insert into users(user_id,name) values(101,'Fake model');
            insert into masters(master_id,name) values(201,'Fake master');
            insert into services(name) values('Fake service');
            insert into slots(date_time,status,master_id,service_id)
                values('2025-01-01T12:00:00Z','Занят',201,1);
            insert into bookings(user_id,slot_id,status) values(101,1,'Активна');
        """)
        snapshot = """select jsonb_build_object(
            'users',(select jsonb_agg(t) from users t),'masters',(select jsonb_agg(t) from masters t),
            'services',(select jsonb_agg(t) from services t),'slots',(select jsonb_agg(t) from slots t),
            'bookings',(select jsonb_agg(t) from bookings t),'auth',(select jsonb_agg(t) from auth.users t),
            'sequences',(select jsonb_agg(t order by sequencename) from pg_sequences t where schemaname='public'))"""
        before = sql(names[0], snapshot)
        dump = p.command('docker', 'exec', p.db, 'pg_dump', '-U', 'postgres', '-d', names[0])
        digest = hashlib.sha256(dump.encode()).hexdigest()
        sql(names[1], dump)
        assert sql(names[1], snapshot) == before
        sql(names[1], (package / '00_preflight.sql').read_text())
        manifest = json.loads((package / 'manifest.json').read_text())['migration_files']
        for name in SELECTED:
            relative = 'migrations/' + name
            contents = (package / relative).read_bytes()
            assert hashlib.sha256(contents).hexdigest() == manifest[relative]
            sql(names[1], contents.decode())
        assert sql(names[1], snapshot) == before
        assert hashlib.sha256(dump.encode()).hexdigest() == digest
        assert sql(names[1], "select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f' and confdeltype='r'") == '4'
        for role in ('anon', 'authenticated'):
            assert sql(names[1], f"select has_table_privilege('{role}','bookings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')") == 'f'
        assert sql(names[1], "select count(*) from pg_policy where polrelid='storage.objects'::regclass and not polpermissive") == '3'
        print('PASS: fictional PG17 dump -> restore -> strict preflight -> exact ten migrations; rows/sequences/Auth stand-in preserved; ACL/RESTRICT/Storage policies')
    finally:
        for name in names:
            p.sql('drop database if exists ' + name)
        shutil.rmtree(package)


if __name__ == '__main__':
    run(sys.argv[1])
