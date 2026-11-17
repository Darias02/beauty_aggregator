"""Verify the reviewed transfer bytes without accessing any external service."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def verify():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Optionally compare the original private checkout")
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'docs/transfer-manifest.json').read_text())
    for name, expected in manifest['files'].items():
        path = ROOT / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise SystemExit('Transfer mismatch: ' + name)
    if args.source:
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.source).decode().strip()
        if commit != manifest['source_commit']:
            raise SystemExit('Unexpected source commit')
        for name in manifest['files']:
            if name not in manifest['adapted'] and (args.source / name).read_bytes() != (ROOT / name).read_bytes():
                raise SystemExit('Source mismatch: ' + name)
    for name in manifest['excluded']:
        if (ROOT / name).exists():
            raise SystemExit('Excluded source present: ' + name)
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    for name in filter(None, tracked):
        if name.startswith(('supabase/.temp/', 'tests/bb75/artifacts/')) or name.endswith(('.pem', '.p12', '.dump')) or Path(name).name == '.env':
            raise SystemExit('Forbidden tracked path: ' + name)
    print(f"PASS: {len(manifest['files'])} transferred files and {len(manifest['excluded'])} exclusions")


if __name__ == '__main__':
    verify()
