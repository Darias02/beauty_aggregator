"""Prepare a new temporary BB72 project. No installs, containers or cloud calls.

Requires installed Supabase CLI v3; prints the new project path.
python3 tests/bb72/prepare_local.py
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]


def prepare():
    directory = Path(tempfile.mkdtemp(prefix='bb72-local-supabase-', dir='/private/tmp'))
    env = {k: v for k, v in os.environ.items() if k in ('HOME', 'PATH', 'TMPDIR', 'LANG', 'USER')}
    env['SUPABASE_TELEMETRY_DISABLED'] = '1'
    subprocess.run(['supabase', 'init', '--workdir', str(directory)], env=env, check=True)
    config = directory / 'supabase/config.toml'
    text = config.read_text()
    for old, new in [(54321, 57321), (54322, 57322), (54320, 57320),
                     (54323, 57323), (54324, 57324), (54327, 57327),
                     (54329, 57329), (8083, 5783)]:
        text = text.replace(str(old), str(new))
    text = text.replace('[analytics]\nenabled = true', '[analytics]\nenabled = false')
    text = text.replace('[studio]\nenabled = true', '[studio]\nenabled = false')
    # Never import environment-backed external provider secrets from the host.
    text = re.sub(r'"env\([A-Z_]+\)"', '""', text)
    text = text.replace('sql_paths = ["./seed.sql"]', 'sql_paths = ["./seeds/test_catalog.sql"]')
    config.write_text(text + '\n' + (ROOT / 'supabase/config.toml').read_text())
    for name in ('migrations', 'seeds'):
        shutil.copytree(ROOT / 'supabase' / name, directory / 'supabase' / name, dirs_exist_ok=True)
    for source in (ROOT / 'supabase/functions').rglob('*'):
        if source.is_file() and (source.suffix in ('.ts', '.js', '.mjs', '.json', '.lock', '.wasm', '.md', '.txt')
                                 or source.name in ('LICENSE', 'NOTICE')):
            destination = directory / source.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    credentials = directory / 'local-functions.env'
    credentials.write_text('BOT_TOKEN=0:BB72_LOCAL_FAKE_TOKEN\n'
                           'TELEGRAM_WEBHOOK_SECRET=BB72_LOCAL_FAKE_WEBHOOK_SECRET\n'
                           'AVATAR_PUBLIC_ORIGIN=http://127.0.0.1:57321\n')
    credentials.chmod(0o600)
    marker = {'purpose': 'disposable localhost-only BB72', 'project_id': directory.name,
              'api_url': 'http://127.0.0.1:57321', 'docker_context': 'colima-bb72',
              'migrations': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in sorted((directory / 'supabase/migrations').glob('*.sql'))}}
    (directory / 'BB72-LOCAL-ONLY.json').write_text(json.dumps(marker, indent=2) + '\n')
    print(directory)
    return directory


if __name__ == '__main__':
    prepare()
