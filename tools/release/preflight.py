"""Read-only offline release checks. Never prints environment values or runs deploy."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import tomllib
from urllib.parse import urlsplit

WASM_SHA = '54629cbcf06dd10db38b4d87fa6ab241b248c09c94f2d9689506e5f994ac5f0c'


def url_ok(value):
    try:
        u = urlsplit(value)
        return u.scheme == 'https' and bool(u.hostname) and not (u.username or u.password or u.query or u.fragment)
    except ValueError:
        return False


def privileged(value):
    if value.startswith('sb_secret_'):
        return True
    try:
        body = value.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4))).get('role') == 'service_role'
    except (ValueError, IndexError, TypeError, AttributeError):
        return False


def check_env(env, scope):
    errors = []
    def need(name, valid):
        if not valid:
            errors.append(name + ': invalid or missing')
    if scope in ('edge', 'bot'):
        need('BOT_TOKEN', bool(re.fullmatch(r'[1-9]\d*:[A-Za-z0-9_-]+', env.get('BOT_TOKEN', ''))))
    if scope == 'bot':
        need('SUPABASE_URL', url_ok(env.get('SUPABASE_URL', '')))
        need('SUPABASE_KEY', privileged(env.get('SUPABASE_KEY', '')))
    if scope == 'edge':
        need('SUPABASE_URL', url_ok(env.get('SUPABASE_URL', '')))
        try:
            keys = json.loads(env.get('SUPABASE_SECRET_KEYS', '{}'))
            key = keys.get('default') or env.get('SUPABASE_SERVICE_ROLE_KEY', '')
            need('SUPABASE_ADMIN_KEY', isinstance(key, str) and privileged(key))
        except (ValueError, AttributeError):
            need('SUPABASE_ADMIN_KEY', False)
        need('BOT_USERNAME', bool(re.fullmatch(r'@?[A-Za-z0-9_]{5,32}', env.get('BOT_USERNAME', ''))))
        need('TELEGRAM_WEBHOOK_SECRET', bool(re.fullmatch(r'[A-Za-z0-9_-]{32,256}', env.get('TELEGRAM_WEBHOOK_SECRET', ''))))
        if env.get('AVATAR_PUBLIC_ORIGIN'):
            need('AVATAR_PUBLIC_ORIGIN', url_ok(env['AVATAR_PUBLIC_ORIGIN']))
    if scope in ('edge', 'bot'):
        need('WEB_APP_URL', url_ok(env.get('WEB_APP_URL', '')))
    if scope == 'frontend':
        need('BB_SUPABASE_URL', url_ok(env.get('BB_SUPABASE_URL', '')))
        key = env.get('BB_SUPABASE_PUBLISHABLE_KEY', '')
        need('BB_SUPABASE_PUBLISHABLE_KEY', key.startswith('sb_publishable_') and len(key) > 20)
        for name, value in env.items():
            if name.startswith(('BB_', 'VITE_', 'NEXT_PUBLIC_', 'PUBLIC_')) and (
                any(word in name for word in ('SECRET', 'SERVICE_ROLE', 'BOT_TOKEN', 'DATABASE', 'PASSWORD')) or privileged(value)
            ):
                errors.append('public environment: forbidden credential')
    return errors


def check_edge(root):
    errors = []
    functions = root / 'supabase/functions'
    config = tomllib.loads((root / 'supabase/config.toml').read_text())['functions']
    names = {p.name for p in functions.iterdir() if p.is_dir() and not p.name.startswith('_')}
    for name in sorted(names | config.keys()):
        folder = functions / name
        if not (folder / 'index.ts').is_file():
            errors.append(name + ': missing entrypoint')
        if name not in config or config[name].get('verify_jwt') is not False:
            errors.append(name + ': review explicit authentication configuration')
        for item in ['deno.json', 'deno.lock']:
            if not (folder / item).is_file():
                errors.append(name + ': missing ' + item)
        if (folder / 'deno.json').is_file():
            settings = json.loads((folder / 'deno.json').read_text())
            for task in ['check', 'test']:
                if task not in settings.get('tasks', {}):
                    errors.append(name + ': missing task ' + task)
        # Covers direct source imports and import maps, including shared production code.
        paths = [p for p in folder.glob('*.ts') if not p.name.endswith(('_test.ts', '.test.ts'))]
        paths += list(folder.glob('deno.json'))
        for path in paths:
            for spec in re.findall(r'["\']((?:npm:|https://)[^"\']+)["\']', path.read_text()):
                if spec.startswith('npm:') and not re.search(r'@\d+\.\d+\.\d+(?:[/]|$)', spec):
                    errors.append(name + ': unpinned npm import')
                if spec.startswith('https://') and ('/std' in spec or 'esm.sh/' in spec) and not re.search(r'@\d+\.\d+\.\d+', spec):
                    errors.append(name + ': unpinned remote import')
    wasm = functions / 'master-avatar/vendor/magick.wasm'
    if not wasm.is_file() or hashlib.sha256(wasm.read_bytes()).hexdigest() != WASM_SHA:
        errors.append('master-avatar: WASM checksum mismatch')
    for name in ['LICENSE', 'NOTICE']:
        if not (wasm.parent / name).is_file():
            errors.append('master-avatar: missing ' + name)
    if './functions/master-avatar/vendor/magick.wasm' not in config.get('master-avatar', {}).get('static_files', []):
        errors.append('master-avatar: WASM not included in static_files')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['edge', 'env'])
    parser.add_argument('--scope', choices=['frontend', 'bot', 'edge'])
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    try:
        if args.mode == 'env' and not args.scope:
            parser.error('--scope required for env')
        errors = check_edge(args.root) if args.mode == 'edge' else check_env(os.environ, args.scope)
    except (OSError, ValueError, KeyError, TypeError):
        parser.exit(1, 'FAIL: invalid local configuration\n')
    for error in errors:
        print('BLOCK: ' + error)
    print('FAIL' if errors else 'PASS: offline checks only; release approval still required')
    raise SystemExit(bool(errors))


if __name__ == '__main__':
    main()
