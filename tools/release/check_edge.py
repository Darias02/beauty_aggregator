"""Run offline Edge checks with frozen locks; no serve, deploy or cloud access."""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def run():
    for config in sorted((ROOT / 'supabase/functions').glob('*/deno.json')):
        folder = config.parent
        tasks = json.loads(config.read_text())['tasks']
        lock = folder / 'deno.lock'
        before = hashlib.sha256(lock.read_bytes()).digest()
        print('CHECK ' + folder.name, flush=True)
        # Task globs are expanded explicitly without a shell.
        for mode in ('check', 'lint', 'test'):
            command = tasks.get(mode)
            if command is None and mode == 'lint':
                command = 'deno lint ' + ' '.join(p.name for p in folder.glob('*.ts'))
            for step in command.split(' && '):
                args = shlex.split(step)
                if args[:2] in (['deno', 'check'], ['deno', 'test']):
                    args[2:2] = ['--cached-only', '--frozen']
                expanded = []
                for arg in args:
                    expanded.extend(sorted(str(p.relative_to(folder)) for p in folder.glob(arg))
                                    if '*' in arg else [arg])
                subprocess.run(expanded, cwd=folder, check=True)
        if hashlib.sha256(lock.read_bytes()).digest() != before:
            raise RuntimeError(folder.name + ': lock changed during frozen checks')
    print('PASS: all Edge checks; lockfiles unchanged')


if __name__ == '__main__':
    run()
