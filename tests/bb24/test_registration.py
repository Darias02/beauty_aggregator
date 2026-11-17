"""Test the legacy bot's registration without importing its live database client."""
from pathlib import Path
import runpy
from types import SimpleNamespace
from unittest.mock import Mock


def test_python_registration_preserves_existing_profile(monkeypatch):
    rows = {101: {'user_id': 101, 'name': 'Edited profile', 'phone_number': '+79990000000'}}
    table = Mock()

    def upsert(data, *, on_conflict, ignore_duplicates):
        assert on_conflict == 'user_id'
        assert ignore_duplicates is True
        rows.setdefault(data['user_id'], data.copy())
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[]))

    table.upsert.side_effect = upsert
    client = Mock()
    client.table.return_value = table
    monkeypatch.setitem(__import__('sys').modules, 'database.client', SimpleNamespace(supabase=client))
    module = runpy.run_path(str(Path(__file__).resolve().parents[2] / 'database/repositories/users.py'))
    module['add_user'](101, 'Telegram name')
    assert rows[101] == {'user_id': 101, 'name': 'Edited profile', 'phone_number': '+79990000000'}
    module['add_user'](102, 'New user', '+79991111111')
    assert rows[102] == {'user_id': 102, 'name': 'New user', 'phone_number': '+79991111111'}
    client.table.assert_called_with('users')
