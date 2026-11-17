"""New FK protection on disposable PostgreSQL, fake data only."""
from pathlib import Path

import pytest

from tests.bb63.test_slots_write import ROOT, cluster, db, slot

PATCH = ROOT / 'supabase/migrations/20261113135354_bb73_preserve_parent_history.sql'


@pytest.mark.parametrize('parent,key,value', [
    ('masters', 'master_id', 201), ('services', 'service_id', 301),
    ('users', 'user_id', 101), ('slots', 'slot_id', None),
])
def test_direct_parent_deletion_cannot_cascade_history(db, parent, key, value):
    identifier = slot(db)
    db(f"insert into bookings(user_id,slot_id,status,reason) values(101,{identifier},'Отменена моделью','time')")
    snapshot = db('select json_agg(b) from bookings b')
    error = db(f'set role service_role; delete from {parent} where {key}={identifier if value is None else value}', success=False)
    assert '23001' in error or '23503' in error  # PostgreSQL 18 / 17 wording and SQLSTATE differ.
    assert db('select json_agg(b) from bookings b') == snapshot
    assert db('select count(*) from bookings b join slots s using(slot_id)') == '1'


def test_replay_keeps_data_and_crud_but_denies_server_truncate(db):
    identifier = slot(db)
    db(f"insert into bookings(user_id,slot_id,status) values(101,{identifier},'Отменена моделью')")
    before = db('select json_agg(b) from bookings b')
    for _ in range(2):
        db(PATCH.read_text())
        assert db('select json_agg(b) from bookings b') == before
    for table in ('users', 'masters', 'services', 'slots', 'bookings'):
        for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'):
            assert db(f"select has_table_privilege('service_role','public.{table}','{privilege}')") == 't'
        assert '42501' in db(f'set role service_role; truncate {table} cascade', success=False)


def test_unexpected_fk_aborts_without_partial_conversion(db):
    db('alter table slots drop constraint slots_master_id_fkey, add constraint slots_master_id_fkey foreign key(master_id) references masters(master_id) on delete cascade')
    db('alter table bookings drop constraint bookings_user_id_fkey, add constraint bookings_user_id_fkey foreign key(user_id) references users(user_id) on delete set null')
    assert 'FK drift' in db(PATCH.read_text(), success=False)
    assert db("select confdeltype from pg_constraint where conname='bookings_user_id_fkey'") == 'n'
    assert db("select confdeltype from pg_constraint where conname='slots_master_id_fkey'") == 'c'


def test_empty_slot_still_deletes_and_parent_without_dependants_can_delete(db):
    identifier = slot(db)
    assert db(f'set role service_role; select bb63_delete_slot(201,{identifier})') == 't'
    db('set role service_role; delete from masters where master_id=201')
    assert db('select count(*) from masters where master_id=201') == '0'
