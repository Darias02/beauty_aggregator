"""Reset only the guarded disposable BB72 stack twice. Supabase CLI v3 only.

python3 tests/bb72/reset_local.py /private/tmp/bb72-local-supabase-<suffix>
Stop functions serve before invoking. No remote targets or environment DSNs.
"""
import json
from pathlib import Path
import sys

from local_probe import Probe


def reset(directory):
    probe = Probe(directory)
    assert probe.command('supabase', '--version') == '3.0.0'
    # Probe validates the local socket, config, container labels, port binding,
    # localhost status and absence of a cloud project-ref before every reset.
    results = []
    for iteration in (1, 2):
        probe = Probe(directory)
        probe.schema()
        probe.sql('create table public.bb72_reset_probe(value int); insert into public.bb72_reset_probe values(72)')
        output = probe.command('supabase', 'db', 'reset', '--workdir',
                               str(probe.directory), '--network-id', 'bb72-local-only', '--yes')
        (probe.directory / f'reset-{iteration}.log').write_text(output)
        assert probe.sql("select to_regclass('public.bb72_reset_probe') is null") == 't'
        probe.schema()
        assert probe.sql('select count(*) from services') == '3'
        assert probe.sql('select count(*) from bookings') == '0'
        count = len(list((probe.directory / 'supabase/migrations').glob('*.sql')))
        results.append(f'reset {iteration}: sentinel removed, {count} migrations, 3 seed services, no bookings')
        print('PASS', results[-1], flush=True)
    (Path(directory) / 'reset-results.json').write_text(json.dumps(results, indent=2) + '\n')


if __name__ == '__main__':
    reset(sys.argv[1])
