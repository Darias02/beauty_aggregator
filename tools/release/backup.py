"""Offline bundle verification and synthetic file restore. Never connects to a service."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

REQUIRED = {'postgres/schema.sql', 'postgres/data.sql', 'postgres/roles.sql',
            'auth/metadata.json', 'config/settings.json', 'storage/inventory.json'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_file(root, name):
    if not isinstance(name, str) or not name or '\\' in name:
        raise ValueError('invalid path')
    path = Path(name)
    if path.is_absolute() or any(p in ('.', '..') for p in name.split('/')):
        raise ValueError('invalid path')
    current = root
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('symlink forbidden')
    if not current.is_file():
        raise ValueError('file missing')
    return current


def verify(root):
    root = Path(root)
    if root.is_symlink():
        raise ValueError('symlink forbidden')
    manifest = json.loads(safe_file(root, 'manifest.json').read_text())
    if manifest.get('version') != 1 or manifest.get('kind') != 'bb74-synthetic':
        raise ValueError('only synthetic rehearsal bundles supported')
    entries = manifest['files']
    if not isinstance(entries, dict) or not REQUIRED <= entries.keys():
        raise ValueError('required component missing')
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('symlink forbidden')
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    if actual != set(entries) | {'manifest.json'}:
        raise ValueError('unlisted or missing file')
    for name, meta in entries.items():
        data = safe_file(root, name).read_bytes()
        if meta != {'size': len(data), 'sha256': digest(data)}:
            raise ValueError('size or checksum mismatch')
    inventory = json.loads((root / 'storage/inventory.json').read_text())
    objects = inventory['objects']
    seen = set()
    for obj in objects:
        key = (obj['bucket'], obj['key'])
        if key in seen or not obj['mime']:
            raise ValueError('duplicate object or missing MIME')
        seen.add(key)
        name = obj['file']
        if not name.startswith('storage/objects/') or name not in entries:
            raise ValueError('object missing')
        if {k: obj[k] for k in ('size', 'sha256')} != entries[name]:
            raise ValueError('object metadata mismatch')
    if {o['file'] for o in objects} != {n for n in entries if n.startswith('storage/objects/')}:
        raise ValueError('orphan object')
    auth = json.loads((root / 'auth/metadata.json').read_text())
    if len({u['id'] for u in auth['users']}) != len(auth['users']):
        raise ValueError('duplicate auth user')
    if manifest['counts'] != {'objects': len(objects), 'auth_users': len(auth['users'])}:
        raise ValueError('count mismatch')
    return manifest


def fixture(root):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    files = {
        'postgres/schema.sql': b'CREATE TABLE rehearsal(id integer PRIMARY KEY, name text NOT NULL);\n',
        'postgres/data.sql': b"INSERT INTO rehearsal VALUES (1, 'fictional');\n",
        'postgres/roles.sql': b'-- synthetic roles: no privileged production grants\n',
        'auth/metadata.json': json.dumps({'users': [{'id': 'fictional-user', 'app_metadata': {}, 'user_metadata': {}}]}).encode(),
        'config/settings.json': b'{"synthetic":true,"secret_references":[],"external_sends":false}',
        'storage/objects/0001': b'fictional-avatar-bytes',
    }
    obj = files['storage/objects/0001']
    files['storage/inventory.json'] = json.dumps({'objects': [{
        'bucket': 'fictional', 'key': 'avatar/example.bin', 'mime': 'application/octet-stream',
        'file': 'storage/objects/0001', 'size': len(obj), 'sha256': digest(obj)}]}).encode()
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o600)
    manifest = {'version': 1, 'kind': 'bb74-synthetic',
                'counts': {'objects': 1, 'auth_users': 1},
                'files': {n: {'size': len(d), 'sha256': digest(d)} for n, d in files.items()}}
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (root / 'manifest.json').chmod(0o600)
    verify(root)


def restore(root, destination):
    verify(root)
    destination = Path(destination)
    if Path(root).resolve() in destination.resolve().parents:
        raise ValueError('destination inside source forbidden')
    if destination.exists() or destination.is_symlink():
        raise ValueError('restore destination must not exist')
    try:
        shutil.copytree(root, destination, symlinks=True)
        verify(destination)
    except Exception:
        if destination.exists() and not destination.is_symlink():
            shutil.rmtree(destination)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['fixture', 'verify', 'restore'])
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    try:
        if args.action == 'fixture':
            fixture(args.bundle)
        elif args.action == 'verify':
            verify(args.bundle)
        elif args.destination:
            restore(args.bundle, args.destination)
        else:
            raise ValueError('destination required')
    except (ValueError, KeyError, TypeError, OSError):
        parser.exit(1, 'FAIL: invalid synthetic bundle or destination\n')
    print('PASS: synthetic ' + args.action)


if __name__ == '__main__':
    main()
