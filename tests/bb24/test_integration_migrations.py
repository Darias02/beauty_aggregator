"""Run the actual migration chain in the disposable local PostgreSQL fixture."""
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_full_migration_chain_preserves_server_access_and_closes_clients(database_factory):
    db = database_factory(migrate=False)
    with db.connect() as conn:
        # Minimal Supabase Storage schema; no external Storage API is contacted.
        conn.execute("""
            create schema storage;
            create table storage.buckets (
                id text primary key, name text, public boolean,
                file_size_limit bigint, allowed_mime_types text[]
            );
            create table storage.objects (id bigint, bucket_id text);
            alter table storage.objects enable row level security;
            grant usage on schema storage to anon, authenticated, service_role;
            grant all on all tables in schema storage to anon, authenticated, service_role;
        """)
        for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            # This legacy fixture already loaded the snapshot. The independent
            # BB-70 suite verifies the complete chain from an empty database.
            if migration.name.endswith("_bb70_database_baseline.sql"):
                continue
            conn.execute(migration.read_text())
        assert conn.execute("""
            select public, file_size_limit, allowed_mime_types
            from storage.buckets where id = 'master-avatars'
        """).fetchone() == (True, 5242880, ['image/jpeg', 'image/png', 'image/webp'])
    with db.connect("service_role") as conn:
        # Profile ensure/rename and BB-57 insert-only registration coexist.
        conn.execute("update users set phone_number = '+79990000000' where user_id = 101")
        conn.execute("update users set name = 'Edited profile' where user_id = 101")
        conn.execute("""
            insert into users (user_id, name) values (101, 'Telegram name')
            on conflict (user_id) do nothing
        """)
        assert conn.execute("select name, phone_number from users where user_id = 101").fetchone() == (
            'Edited profile', '+79990000000',
        )
        assert conn.execute("select telegram_webhook_claim(900, 1, %s)", (
            '00000000-0000-4000-8000-000000000001',
        )).fetchone()[0] == 'acquired'
    first = db.book()
    assert first['replayed'] is False
    assert db.book() == {**first, 'replayed': True}
    for role in ['anon', 'authenticated']:
        with db.connect(role) as conn:
            for statement in [
                'select * from users',
                "update users set name = 'forged' where user_id = 101",
                'select bb24_book_slot(101, 1)',
                "select telegram_webhook_claim(900, 2, '00000000-0000-4000-8000-000000000001')",
                "insert into storage.objects values (1, 'master-avatars')",
            ]:
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(statement)
