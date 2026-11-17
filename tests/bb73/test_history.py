"""History preservation on disposable PostgreSQL only; never loads a DSN."""
from concurrent.futures import ThreadPoolExecutor
import json

import pytest

from tests.bb63.test_slots_write import cluster, db, slot, wait_for_lock_holder
from tests.bb63.test_slots_write import ROOT


def operation(path, identifier):
    function = 'bb63_delete_slot' if path == 'delete' else 'bb64_cancel_slot'
    return f'select {function}(201,{identifier})'


@pytest.mark.parametrize('path', ['delete', 'cancel'])
@pytest.mark.parametrize('status,reason', [
    ('Отменена мастером', 'model'),
    ('Отменена мастером', 'plans'),
    ('Отменена моделью', 'time'),
    ('Отменена моделью', 'other'),
    ('confirmed', None),
    (None, None),
])
def test_any_history_blocks_both_paths_and_retries_without_changes(db, path, status, reason):
    identifier = slot(db)
    # Fixture values only. JSON literals give SQL-safe text via jsonb extraction.
    payload = json.dumps({'status': status, 'reason': reason}, ensure_ascii=False)
    db(f"""insert into bookings(user_id,slot_id,status,reason)
        select 101,{identifier},j->>'status',j->>'reason' from
        (select '{payload}'::jsonb j) fixture""")
    before = db('select json_agg(b order by booking_id) from bookings b')
    for _ in range(2):
        error = db('set role service_role; ' + operation(path, identifier), success=False)
        expected = 'BB64_INVALID_STATE' if path == 'cancel' and status in (None, 'confirmed') else 'BB73_SLOT_HAS_HISTORY'
        assert 'PT409' in error and expected in error
        assert db('select json_agg(b order by booking_id) from bookings b') == before
        assert db('select status from slots') == 'Свободен'
        assert db('select count(*) from bookings b join slots s using(slot_id)') == '1'


@pytest.mark.parametrize('path', ['delete', 'cancel'])
def test_history_created_while_waiting_is_preserved(db, path):
    identifier = slot(db)
    with ThreadPoolExecutor() as pool:
        writer = pool.submit(db, f"""begin; set role service_role;
            select 1 from slots where slot_id={identifier} for update;
            insert into bookings(user_id,slot_id,status,reason)
            values(101,{identifier},'Отменена моделью','time');
            select pg_sleep(.4); commit""", blocker=True)
        wait_for_lock_holder(db)
        error = db('set role service_role; ' + operation(path, identifier), success=False)
        writer.result()
    assert 'BB73_SLOT_HAS_HISTORY' in error
    assert db('select count(*) from bookings b join slots s using(slot_id)') == '1'


@pytest.mark.parametrize('path', ['delete', 'cancel'])
def test_deletion_wins_before_legacy_fk_insert(db, path):
    identifier = slot(db)
    with ThreadPoolExecutor() as pool:
        deletion = pool.submit(db, 'begin; set role service_role; ' +
            operation(path, identifier) + '; select pg_sleep(.4); commit', blocker=True)
        wait_for_lock_holder(db)
        error = db(f"""insert into bookings(user_id,slot_id,status)
            values(101,{identifier},'Отменена моделью')""", success=False)
        deletion.result()
    assert '23503' in error
    assert db('select count(*) from slots') == db('select count(*) from bookings') == '0'


def test_upgrade_preserves_existing_rows_and_acl_and_can_be_repeated(db):
    identifier = slot(db)
    db(f"insert into bookings(user_id,slot_id,status,reason) values(101,{identifier},'Отменена моделью','time')")
    old = (ROOT / 'supabase/migrations/20261101140000_bb63_slots_write.sql').read_text()
    # Reconstruct the pre-BB73 RPC without changing historical source files.
    definition = old[old.index('create function public.bb63_delete_slot'):old.index('revoke all')]
    db(definition.replace('create function', 'create or replace function', 1))
    snapshot = "select jsonb_build_object('slots',(select jsonb_agg(s) from slots s),'bookings',(select jsonb_agg(b) from bookings b))"
    before = db(snapshot)
    migration = next((ROOT / 'supabase/migrations').glob('*_bb73_preserve_booking_history.sql')).read_text()
    for _ in range(2):
        db(migration)
        assert db(snapshot) == before
        assert 'BB73_SLOT_HAS_HISTORY' in db(operation('delete', identifier), success=False)
        for role in ('anon', 'authenticated'):
            assert '42501' in db(f'set role {role}; ' + operation('delete', identifier), success=False)


def test_suppressed_delete_never_reports_success(db):
    identifier = slot(db)
    db('''create function prevent_delete() returns trigger language plpgsql as $$
        begin return null; end $$;
        create trigger prevent_delete before delete on slots
        for each row execute function prevent_delete();''')
    assert 'PT409' in db(operation('delete', identifier), success=False)
    assert db('select count(*) from slots') == '1'
