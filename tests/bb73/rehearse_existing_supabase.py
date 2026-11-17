"""Run the reviewed upgrade only on a new, guarded, local Supabase with fake rows.

Requires a running BB72 temporary project with NO copied migrations or seeds.
Never accepts cloud URLs/DSNs/keys, never invokes reset, push, repair or deploy.
"""
import base64
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/bb72'))
sys.path.insert(0, str(ROOT / 'scripts'))
from local_probe import Probe
from prepare_existing_upgrade import prepare


def run(directory):
    p = Probe(directory)
    assert not list((p.directory / 'supabase/migrations').glob('*.sql'))
    assert p.sql("select to_regclass('public.users') is null") == 't'
    package = prepare()
    manifest = json.loads((package / 'manifest.json').read_text())
    assert hashlib.sha256((package / 'local-fixture.sql').read_bytes()).hexdigest() == manifest['local_fixture_sha256']
    for name, digest in manifest['migration_files'].items():
        assert hashlib.sha256((package / name).read_bytes()).hexdigest() == digest
    # CLI may initialize an empty bookkeeping table in a fresh local project.
    # Remove only that empty LOCAL table to reproduce audited production absence.
    if p.sql("select to_regclass('supabase_migrations.schema_migrations') is null") == 'f':
        assert p.sql('select count(*) from supabase_migrations.schema_migrations') == '0'
        p.sql('drop table supabase_migrations.schema_migrations')
    p.sql((package / 'local-fixture.sql').read_text())
    p.sql("""insert into users(user_id,name) values(101,'Fake model'),(102,'Other fake model');
        insert into masters(master_id,name) values(201,'Fake master');
        insert into services(name) values('Fake service');
        insert into slots(date_time,status,master_id,service_id,city)
            values(now()-interval '1 day','Занят',201,1,null);
        insert into bookings(user_id,slot_id,status) values(101,1,'Активна');""")
    source = (ROOT / 'supabase/functions/master-avatar/tests/fixtures.ts').read_text()
    import re
    png = base64.b64decode(re.search(r"'png':\s*'([^']+)'", source)[1])
    path = '/storage/v1/object/master-avatars/201/bb73-fixture.png'
    status, _ = p.http(path, png, token=p.keys['SERVICE_ROLE_KEY'], content_type='image/png')
    assert status == 200, status
    avatar = p.url + '/storage/v1/object/public/master-avatars/201/bb73-fixture.png'
    p.sql(f"update masters set avatar_url='{avatar}' where master_id=201")
    snapshot = "select jsonb_build_object('users',(select jsonb_agg(u order by user_id) from users u),'masters',(select jsonb_agg(m order by master_id) from masters m),'services',(select jsonb_agg(v order by service_id) from services v),'slots',(select jsonb_agg(s order by slot_id) from slots s),'bookings',(select jsonb_agg(b order by booking_id) from bookings b))"
    before = p.sql(snapshot)
    for mutation, expected in [
        ('alter table public.slots add column bb73_drift text', 'column drift'),
        ('drop index public.slots_city_idx', 'index drift'),
    ]:
        try:
            p.sql('begin; ' + mutation + '; ' + (package / '00_preflight.sql').read_text() + ' commit;')
        except RuntimeError as error:
            assert expected in str(error)
        else:
            raise AssertionError('Preflight ignored schema drift')
    assert p.sql(snapshot) == before
    p.sql((package / '00_preflight.sql').read_text())
    for name in manifest['migration_files']:
        if name == '00_preflight.sql':
            continue
        p.sql((package / name).read_text())
    assert p.sql(snapshot) == before
    status, data = p.http('/storage/v1/object/public/master-avatars/201/bb73-fixture.png')
    assert status == 200 and data == png
    assert p.sql("select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f' and confdeltype='r'") == '4'
    assert p.sql("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity") == '6'
    for role in ('anon','authenticated'):
        assert p.sql(f"select has_table_privilege('{role}','public.bookings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')") == 'f'
    for parent, key, value in [('users','user_id',101),('masters','master_id',201),('services','service_id',1),('slots','slot_id',1)]:
        try:
            p.sql(f'set role service_role; delete from {parent} where {key}={value}')
        except RuntimeError as error:
            assert 'foreign key constraint' in str(error)
        else:
            raise AssertionError('Parent deletion was allowed')
    assert p.sql(snapshot) == before
    p.passed('audited existing shape -> selected 10 migrations; exact fake row and avatar byte preservation; four RESTRICT FKs; RLS/ACL')
    assert p.edge('bookings-read', 101, {'action': 'booking', 'booking_id': 1})['booking']['slots']['city'] is None
    p.bookings(expected_services=1)
    p.concurrency()
    p.passed('existing-database upgrade with managed local Storage and real Edge APIs complete')
    print('PASS synthetic upgrade rehearsal; no production data or cloud credentials used')


if __name__ == '__main__':
    if sys.argv[1] == '--prepare':
        if not __debug__:
            raise RuntimeError('Run without -O')
        from prepare_local import prepare as prepare_local
        new = prepare_local()
        assert new.parent == Path('/private/tmp') and new.name.startswith('bb72-local-supabase-')
        for migration in (new / 'supabase/migrations').glob('*.sql'):
            migration.unlink()
        config = new / 'supabase/config.toml'
        config.write_text(config.read_text().replace('sql_paths = ["./seeds/test_catalog.sql"]', 'sql_paths = []'))
        marker = new / 'BB72-LOCAL-ONLY.json'
        value = json.loads(marker.read_text())
        value['migrations'] = {}
        marker.write_text(json.dumps(value, indent=2) + '\n')
        print('EMPTY EXISTING-DB REHEARSAL:', new)
    else:
        run(sys.argv[1])
