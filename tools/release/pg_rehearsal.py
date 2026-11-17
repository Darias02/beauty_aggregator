"""Dump/restore generated fictional data in a fresh Unix-socket-only PostgreSQL cluster.
No URL, existing database, external SQL, environment credentials or TCP accepted.
"""
import argparse
from pathlib import Path
import subprocess
import tempfile


def run(bindir):
    bindir = Path(bindir).resolve()
    required = ['initdb', 'pg_ctl', 'psql', 'createdb', 'pg_dump', 'pg_restore']
    if not all((bindir / n).is_file() for n in required):
        raise ValueError('PostgreSQL binaries missing')
    with tempfile.TemporaryDirectory(prefix='bb74-pg-', dir='/private/tmp') as temp:
        root = Path(temp)
        env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'TMPDIR': temp}
        def call(name, *args, sql=None):
            result = subprocess.run([str(bindir / name), *args], env=env,
                                    input=sql, text=True, capture_output=True, timeout=90)
            if result.returncode:
                raise RuntimeError('local PostgreSQL step failed: ' + name)
            return result.stdout.strip()
        data = str(root / 'data')
        socket = str(root)
        call('initdb', '-D', data, '-U', 'bb74', '-A', 'trust', '--no-locale')
        started = False
        try:
            call('pg_ctl', '-D', data, '-l', str(root / 'server.log'), '-o',
                 f"-c listen_addresses='' -c unix_socket_directories='{socket}'", '-w', 'start')
            started = True
            conn = ['-h', socket, '-U', 'bb74']
            for db in ['source', 'restored']:
                call('createdb', *conn, db)
            call('psql', *conn, '-d', 'source', '-v', 'ON_ERROR_STOP=1', sql="""
CREATE SCHEMA auth;
CREATE TABLE auth.users(id int PRIMARY KEY, app_metadata jsonb, user_metadata jsonb);
INSERT INTO auth.users VALUES(1, '{"role":"fictional"}', '{}');
CREATE TABLE public.bookings(id int PRIMARY KEY, user_id int REFERENCES auth.users);
INSERT INTO public.bookings VALUES(42,1);
CREATE TABLE public.receipts(id int PRIMARY KEY, status text);
INSERT INTO public.receipts VALUES(7,'sending');
""")
            dump = str(root / 'fictional.dump')
            call('pg_dump', *conn, '-d', 'source', '-Fc', '-f', dump)
            call('pg_restore', *conn, '-d', 'restored', '--exit-on-error', '--single-transaction', dump)
            sql = "SELECT row_to_json(t) FROM (SELECT b.id,u.app_metadata,u.user_metadata,r.status FROM bookings b JOIN auth.users u ON u.id=b.user_id CROSS JOIN receipts r) t;"
            before = call('psql', *conn, '-d', 'source', '-At', '-c', sql)
            after = call('psql', *conn, '-d', 'restored', '-At', '-c', sql)
            if before != after or 'fictional' not in after or 'sending' not in after:
                raise RuntimeError('restored data mismatch')
        finally:
            if started:
                call('pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop')
    print('PASS: fictional PostgreSQL dump/restore, FK, Auth metadata, receipt state')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', required=True)
    args = parser.parse_args()
    run(args.pg_bin)
