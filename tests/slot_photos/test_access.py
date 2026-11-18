"""Disposable PostgreSQL only. Uses no remote configuration or credentials."""
import json
import uuid
import pytest
from tests.bb70.test_baseline import database, cluster  # noqa: F401


def setup(execute):
    execute("insert into public.users(user_id,name) values(101,'Model'),(102,'Other'); insert into public.masters(master_id,name) values(201,'Owner'),(202,'Other'); insert into public.services(service_id,name) values(301,'Service'); insert into public.slots(slot_id,master_id,service_id,date_time,status) values(1,201,301,now()+interval '1 day','Свободен'),(2,201,301,now()-interval '1 day','Занят');")


def write(execute, actor, slot, photo, action, success=True):
    return execute(f"select row_to_json(r) from public.slot_photos_write({actor},{slot},'{photo}','{action}') r", success=success)


def test_ownership_limit_retry_and_cleanup(database):
    setup(database)
    ids = [str(uuid.uuid4()) for _ in range(4)]
    assert 'PT404' in write(database,202,1,ids[0],'reserve',False)
    for photo in ids[:3]:
        result = json.loads(write(database,201,1,photo,'reserve'))
        assert result['object_path'] == f'201/1/{photo}.jpg'
    assert 'PT409' in write(database,201,1,ids[3],'reserve',False)
    assert json.loads(write(database,201,1,ids[0],'reserve'))['photo_id'] == ids[0]
    write(database,201,1,ids[0],'finish')
    database("update public.slot_photos set created_at=now()-interval '2 days'; select count(*) from public.slot_photos_cleanup();")
    assert database("select state from public.slot_photos where photo_id='"+ids[0]+"'") == 'ready'
    assert 'PT404' in write(database,201,1,ids[1],'finish',False)
    assert 'PT404' in write(database,202,1,ids[0],'delete',False)
    write(database,201,1,ids[0],'delete')
    assert database('select count(*) from public.slots') == '2'


def test_read_access_archive_participant_and_client_denial(database):
    setup(database)
    photo = str(uuid.uuid4())
    write(database,201,2,photo,'reserve'); write(database,201,2,photo,'finish')
    assert database('select public.slot_photos_access(101,1)') == 't'
    assert database('select public.slot_photos_access(101,2)') == 'f'
    database("insert into public.bookings(user_id,slot_id,status) values(101,2,'Активна');")
    assert database('select public.slot_photos_access(101,2)') == 't'
    assert database('select public.slot_photos_access(201,2)') == 't'
    assert database('select public.slot_photos_access(102,2)') == 'f'
    assert database('select count(*) from public.slot_photos_list(101,2)') == '1'
    for role in ('anon','authenticated'):
        assert 'permission denied' in database(f'set role {role}; select * from public.slot_photos',success=False)
        assert 'permission denied' in database(f'set role {role}; select * from public.slot_photos_list(201,2)',success=False)
        assert 'row-level security' in database(f"set role {role}; insert into storage.objects(bucket_id,name) values('slot-photos','evil')",success=False)
    database('delete from public.bookings; delete from public.slots where slot_id=2;')
    assert database('select count(*) from public.slot_photos_cleanup()') == '1'


def test_concurrent_uploads_respect_three_positions(database):
    from concurrent.futures import ThreadPoolExecutor
    setup(database)
    def reserve(_):
        photo = uuid.uuid4()
        database(f"do $$ begin perform public.slot_photos_write(201,1,'{photo}','reserve'); exception when sqlstate 'PT409' then null; end $$;")
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(reserve, range(6)))
    assert database("select count(*) from public.slot_photos where slot_id=1") == '3'
    assert database("select count(distinct position) from public.slot_photos where slot_id=1") == '3'
    assert database("select count(*) from public.slot_photos_list(201,1)") == '3'
    assert database("select count(*) from public.slot_photos_list(101,1)") == '0'


def test_private_storage_defeats_broad_legacy_policies(database):
    database("create policy fixture_broad_slot_photos on storage.objects for all to public using(true) with check(true); insert into storage.objects(id,bucket_id,name) values(44,'slot-photos','201/1/test.jpg');")
    assert database("select public from storage.buckets where id='slot-photos'") == 'f'
    for role in ('anon','authenticated'):
        assert database(f"set role {role}; select count(*) from storage.objects where bucket_id='slot-photos'") == '0'
        assert '42501' in database(f"set role {role}; insert into storage.objects(id,bucket_id,name) values(55,'slot-photos','other')",success=False)
        assert database(f"set role {role}; with changed as (update storage.objects set name='changed' where bucket_id='slot-photos' returning *) select count(*) from changed") == '0'
        assert database(f"set role {role}; with changed as (delete from storage.objects where bucket_id='slot-photos' returning *) select count(*) from changed") == '0'
