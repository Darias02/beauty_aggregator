"""Opt-in real local API checks; stdlib only, no cloud credentials or mock servers.

Run against the disposable project created for BB72:
python3 tests/bb72/local_probe.py /private/tmp/bb72-local-supabase-<suffix>
Requires its running Colima bb72 stack and `functions serve --env-file`.
Does not initialize, reset, stop, link, deploy, or access Telegram.
"""
import base64
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import time
import tomllib
import struct
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor


ROOT = Path(__file__).resolve().parents[2]
FAKE_TOKEN = '0:BB72_LOCAL_FAKE_TOKEN'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Redirects are forbidden in this localhost probe')


def signed(actor):
    fields = {'auth_date': str(int(time.time())),
              'user': json.dumps({'id': actor, 'first_name': 'BB72 local fixture'})}
    secret = hmac.digest(b'WebAppData', FAKE_TOKEN.encode(), 'sha256')
    data = '\n'.join(f'{k}={v}' for k, v in sorted(fields.items()))
    fields['hash'] = hmac.new(secret, data.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(fields)


class Probe:
    def __init__(self, directory):
        if not __debug__:
            raise RuntimeError('Run without -O: the safety assertions must be enabled')
        self.directory = Path(directory).resolve()
        assert self.directory.parent == Path('/private/tmp')
        assert re.fullmatch(r'bb72-local-supabase-[a-z0-9_]+', self.directory.name)
        marker = json.loads((self.directory / 'BB72-LOCAL-ONLY.json').read_text())
        self.project = marker['project_id']
        assert self.project == self.directory.name
        config = tomllib.loads((self.directory / 'supabase/config.toml').read_text())
        assert config['project_id'] == self.project
        assert config['db']['port'] == 57322
        assert config['api']['port'] == 57321
        self.url = marker['api_url']
        assert self.url == 'http://127.0.0.1:57321'
        assert not (self.directory / 'supabase/.temp/project-ref').exists()
        self.env = {k: v for k, v in os.environ.items()
                    if k in ('HOME', 'PATH', 'TMPDIR', 'LANG', 'USER')}
        self.env['DOCKER_HOST'] = 'unix://' + str(Path.home() / '.colima/bb72/docker.sock')
        self.env['SUPABASE_TELEMETRY_DISABLED'] = '1'
        self.db = 'supabase_db_' + self.project
        info = json.loads(self.command('docker', 'inspect', self.db))[0]
        assert info['State']['Running']
        assert info['Config']['Labels']['com.supabase.cli.project'] == self.project
        assert info['Config']['Labels']['com.supabase.cli.workdir'] == str(self.directory)
        assert info['NetworkSettings']['Ports']['5432/tcp'] == [{'HostIp': '127.0.0.1', 'HostPort': '57322'}]
        status = json.loads(self.command('supabase', 'status', '--workdir',
                                        str(self.directory), '--output', 'json'))
        assert status['API_URL'] == self.url
        db_url = urllib.parse.urlsplit(status['DB_URL'])
        assert db_url.hostname == '127.0.0.1' and db_url.port == 57322
        self.keys = status
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        results = self.directory / 'probe-results.json'
        self.results = json.loads(results.read_text()) if results.exists() else []

    def command(self, *args, data=None):
        r = subprocess.run(args, env=self.env, input=data, text=True,
                           capture_output=True, timeout=90)
        if r.returncode:
            raise RuntimeError(f'{args[:3]} failed: {r.stderr[-1500:]}')
        return r.stdout.strip()

    def sql(self, query):
        return self.command('docker', 'exec', '-i', self.db, 'psql', '-XqAt',
                            '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
                            data=query)

    def http(self, path, body=None, *, method=None, token=None, content_type=None):
        assert path.startswith('/') and not path.startswith('//')
        headers = {'apikey': self.keys['ANON_KEY'],
                   'Authorization': 'Bearer ' + (token or self.keys['ANON_KEY'])}
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            content_type = 'application/json'
        if content_type:
            headers['Content-Type'] = content_type
        req = urllib.request.Request(self.url + path, data=body, headers=headers,
                                     method=method or ('POST' if body is not None else 'GET'))
        try:
            response = self.opener.open(req, timeout=90)
        except urllib.error.HTTPError as error:
            response = error
        raw = response.read()
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            value = raw
        return response.code, value

    def edge(self, name, actor, fields, expected=200):
        status, body = self.http('/functions/v1/' + name,
                                 {'init_data': signed(actor), **fields})
        assert status == expected, (name, status, body)
        return body

    def passed(self, name):
        print('PASS', name, flush=True)
        if name not in self.results:
            self.results.append(name)
        (self.directory / 'probe-results.json').write_text(json.dumps(self.results, indent=2) + '\n')

    def schema(self):
        versions = self.sql('select version from supabase_migrations.schema_migrations order by version').splitlines()
        expected = sorted(p.name.split('_')[0] for p in (ROOT / 'supabase/migrations').glob('*.sql'))
        assert versions == expected, (versions, expected)
        for p in (ROOT / 'supabase/migrations').glob('*.sql'):
            assert p.read_bytes() == (self.directory / 'supabase/migrations' / p.name).read_bytes()
        tables = ['users', 'masters', 'services', 'slots', 'bookings', 'telegram_webhook_updates']
        for table in tables:
            assert self.sql(f"select relrowsecurity from pg_class where oid='public.{table}'::regclass") == 't'
            for role in ('anon', 'authenticated'):
                assert self.sql(f"select has_table_privilege('{role}','public.{table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege('{role}','public.{table}','SELECT,INSERT,UPDATE,REFERENCES')") == 'f'
        functions = self.sql("select proname from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and (proname ~ '^bb(24|63|64|66|67)_' or proname ~ '^telegram_webhook_') order by proname").splitlines()
        assert len(functions) == 10, functions
        assert self.sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (proname ~ '^bb(24|63|64|66|67)_' or proname ~ '^telegram_webhook_') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))") == '0'
        bucket = json.loads(self.sql("select row_to_json(b) from (select public,file_size_limit,allowed_mime_types from storage.buckets where id='master-avatars') b"))
        assert bucket == {'public': True, 'file_size_limit': 5242880,
                          'allowed_mime_types': ['image/jpeg', 'image/png', 'image/webp']}, bucket
        self.passed(f'{len(expected)} real migrations, PostgreSQL ACL/RLS/RPC grants and Storage bucket metadata')

    def client_denials(self):
        _, signup = self.http('/auth/v1/signup', {'email': f'bb72-{uuid.uuid4().hex}@example.invalid',
                                                'password': 'BB72-LOCAL-ONLY-fixture-password'})
        assert signup.get('access_token'), signup
        for token in (self.keys['ANON_KEY'], signup['access_token']):
            for table in ('users', 'masters', 'services', 'slots', 'bookings', 'telegram_webhook_updates'):
                code, body = self.http(f'/rest/v1/{table}?select=*', token=token)
                assert code in (401, 403), (table, code, body)
                assert body.get('code') == '42501', body
            code, _ = self.http('/rest/v1/rpc/bb24_book_slot', {'p_user_id': 101, 'p_slot_id': 1}, token=token)
            assert code in (401, 403, 404), code
            code, body = self.http('/storage/v1/object/master-avatars/201/client.png', b'blocked',
                                   token=token, content_type='image/png')
            assert code >= 400 or str(body.get('statusCode')) in ('401', '403'), (code, body)
        assert self.sql("select count(*) from storage.objects where bucket_id='master-avatars' and name='201/client.png'") == '0'
        self.passed('real anon/authenticated Auth tokens denied protected REST tables, RPC and avatar upload')

    def bookings(self, expected_services=3):
        for actor in (101, 102, 103):
            self.edge('user-profile', actor, {'action': 'ensure'})
        self.edge('master-profile', 201, {'action': 'ensure'})
        services = self.edge('catalog', 101, {'action': 'services'})['services']
        assert len(services) == expected_services, services
        service = services[0]['service_id']

        def slot(day):
            stamp = (datetime.now(timezone.utc) + timedelta(days=day)).isoformat(timespec='milliseconds')
            return self.edge('slots-write', 201, {'action': 'create', 'service_id': service,
                'date_time': stamp, 'city': 'BB72 local city', 'address': 'BB72 local address'})['slot']['slot_id']

        first = slot(1)
        available = self.edge('slots-read', 101, {'action': 'available', 'service_id': service})['slots']
        assert any(s['slot_id'] == first and s['services']['service_id'] == service for s in available), available
        assert 'BB72 local city' in self.edge('catalog', 101, {'action': 'cities'})['cities']
        assert self.edge('catalog', 101, {'action': 'counts'})['counts'][str(service)] == 1
        booking = self.edge('booking-create', 101, {'slot_id': first})
        assert booking['replayed'] is False
        bid = booking['booking']['booking_id']
        assert self.edge('booking-create', 101, {'slot_id': first})['replayed'] is True
        self.edge('booking-create', 102, {'slot_id': first}, 409)
        self.edge('bookings-write', 102, {'action': 'confirm', 'booking_id': bid}, 404)
        assert self.edge('bookings-read', 102, {'action': 'booking', 'booking_id': bid})['booking'] is None
        owned = self.edge('bookings-read', 101, {'action': 'booking', 'booking_id': bid})['booking']
        assert owned['slots']['services']['service_id'] == service, owned
        for name in ('notify-user', 'notify-master'):
            for init_data in ('', 'forged'):
                code, body = self.http('/functions/v1/' + name, {'booking_id': bid, 'init_data': init_data})
                assert code == 401, (name, code, body)
        confirm = {'action': 'confirm', 'booking_id': bid}
        assert self.edge('bookings-write', 201, confirm)['booking']['status'] == 'Активна'
        assert self.edge('bookings-write', 201, confirm)['replayed'] is True
        cancel = {'action': 'cancel', 'booking_id': bid, 'reason': 'time'}
        assert self.edge('bookings-write', 101, cancel)['booking']['status'] == 'Отменена моделью'
        assert self.edge('bookings-write', 101, cancel)['replayed'] is True
        second = slot(2)
        bid2 = self.edge('booking-create', 102, {'slot_id': second})['booking']['booking_id']
        assert self.edge('bookings-write', 201, {'action': 'reject', 'booking_id': bid2, 'reason': 'model'})['booking']['reason'] == 'model'
        assert not any(s['slot_id'] == second for s in self.edge('slots-read', 102, {'action': 'available', 'service_id': service})['slots'])
        third = slot(3)
        self.edge('booking-create', 103, {'slot_id': third})
        assert self.edge('slots-write', 201, {'action': 'cancel', 'slot_id': third})['booking']['reason'] == 'plans'
        for identifier in (first, second):
            before = self.sql(f'select row_to_json(b) from bookings b where slot_id={identifier}')
            for action in ('delete', 'cancel'):
                for _ in range(2):
                    body = self.edge('slots-write', 201, {'action': action, 'slot_id': identifier}, 409)
                    assert body['error']['code'] == 'SLOT_HAS_HISTORY', body
                    assert self.sql(f'select row_to_json(b) from bookings b where slot_id={identifier}') == before
                    assert self.sql(f'select count(*) from slots where slot_id={identifier}') == '1'
        empty = slot(4)
        assert self.edge('slots-write', 201, {'action': 'delete', 'slot_id': empty}) == {'deleted': True}
        self.passed('BB73 real Edge delete/cancel reject model/master cancelled history and retries; unchanged rows and FK; empty slot deletes')
        self.passed('real Edge booking create/replay/competition, ownership, confirm/reject/model/master cancel, delete, nested PostgREST/catalog')

    def avatar(self, *, check_storage_limits=True):
        source = (ROOT / 'supabase/functions/master-avatar/tests/fixtures.ts').read_text()
        fixtures = {ext: base64.b64decode(re.search(r"'" + ext + r"':\s*'([^']+)'", source)[1])
                    for ext in ('jpeg', 'png', 'webp')}

        def upload(data, mime, init_data=None):
            boundary = 'BB72' + uuid.uuid4().hex
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="init_data"\r\n\r\n'
                    f'{signed(201) if init_data is None else init_data}\r\n--{boundary}\r\n'
                    f'Content-Disposition: form-data; name="avatar"; filename="fixture"\r\n'
                    f'Content-Type: {mime}\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
            return self.http('/functions/v1/master-avatar', body,
                             content_type='multipart/form-data; boundary=' + boundary)

        for ext in fixtures:
            started = time.monotonic()
            code, body = upload(fixtures[ext], 'image/' + ext)
            assert code == 200, (code, body)
            elapsed = round(time.monotonic() - started, 3)
            url = urllib.parse.urlsplit(body['profile']['avatar_url'])
            assert f'{url.scheme}://{url.netloc}' == self.url, body
            assert url.path.startswith('/storage/v1/object/public/master-avatars/201/'), url.path
            code, content = self.http(url.path)
            assert code == 200 and content == fixtures[ext], (ext, code)
            print(f'AVATAR {ext} upload/read seconds={elapsed}', flush=True)
        for init_data in ('', 'forged'):
            assert upload(fixtures['png'], 'image/png', init_data)[0] == 401
        before = self.sql('select avatar_url from masters where master_id=201')

        def png(width, height):
            def chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
            pixels = zlib.compress((b'\0' + b'\0\0\0' * width) * height)
            return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', pixels) + chunk(b'IEND', b'')

        for data, mime, expected in [(b'not an image', 'image/png', 400),
            (fixtures['png'][:-8], 'image/png', 400), (fixtures['png'], 'image/jpeg', 400),
            (png(9000, 1), 'image/png', 400), (png(2001, 2000), 'image/png', 400),
            (b'x' * (5 * 1024 * 1024 + 1), 'image/png', 413)]:
            code, body = upload(data, mime)
            assert code == expected, (code, body)
        assert self.sql('select avatar_url from masters where master_id=201') == before
        self.passed('real Edge WASM JPEG/PNG/WebP + public Storage roundtrip, forged auth, corrupt/MIME/5MiB application limits')
        if not check_storage_limits:
            return
        for data, mime in [(b'<svg/>', 'image/svg+xml'), (b'x' * (5 * 1024 * 1024 + 1), 'image/png')]:
            code, body = self.http('/storage/v1/object/master-avatars/201/rejected-' + uuid.uuid4().hex,
                                   data, token=self.keys['SERVICE_ROLE_KEY'], content_type=mime)
            assert code >= 400 or int(body.get('statusCode', 200)) >= 400, (code, body)
        self.passed('real Storage bucket MIME/size enforcement')

    def auth_denials(self):
        for name in ('user-profile', 'master-profile', 'catalog', 'slots-read',
                     'slots-write', 'booking-create', 'bookings-read', 'bookings-write'):
            for fields in ({}, {'init_data': 'forged'}):
                code, body = self.http('/functions/v1/' + name, fields)
                assert code == 401, (name, code, body)
        self.passed('real Edge missing/forged initData rejects across eight JSON endpoints')

    def rls(self):
        assert int(self.sql('select count(*) from users')) > 0
        for role in ('anon', 'authenticated'):
            assert self.sql(f'begin; grant select on users to {role}; set local role {role}; select count(*) from users; rollback') == '0'
            # Grant/policy exist only inside the rolled-back transaction. The
            # restrictive bucket policy must still reject a broad allow policy.
            try:
                self.sql(f"begin; create policy bb72_transaction_allow on storage.objects for all to public using(true) with check(true); set local role {role}; insert into storage.objects(bucket_id,name) values('master-avatars','201/rls-probe.png'); rollback")
            except RuntimeError as error:
                assert 'row-level security' in str(error), str(error)
            else:
                raise AssertionError('Restrictive avatar RLS was bypassed')
        assert self.sql("select count(*) from pg_policies where policyname='bb72_transaction_allow'") == '0'
        self.passed('real PostgreSQL RLS denies rows after temporary SELECT grant; restrictive Storage RLS defeats broad allow policy')

    def concurrency(self):
        service = self.edge('catalog', 101, {'action': 'services'})['services'][0]['service_id']
        slot = self.edge('slots-write', 201, {'action': 'create', 'service_id': service,
            'date_time': (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(timespec='milliseconds'),
            'city': 'BB72 concurrency'})['slot']['slot_id']

        def book(actor):
            return actor, self.http('/functions/v1/booking-create', {'init_data': signed(actor), 'slot_id': slot})

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(book, (101, 102)))
        assert sorted(response[0] for _, response in responses) == [200, 409], responses
        winner = next(actor for actor, response in responses if response[0] == 200)
        assert self.edge('booking-create', winner, {'slot_id': slot})['replayed'] is True
        assert self.sql(f'select count(*) from bookings where slot_id={slot}') == '1'
        self.passed('two concurrent real Edge requests: one booking, one conflict, winner retry replays')

    def run(self):
        self.schema()
        self.client_denials()
        self.auth_denials()
        self.bookings()
        self.avatar()
        self.rls()
        self.concurrency()
        (self.directory / 'probe-results.json').write_text(json.dumps(self.results, indent=2) + '\n')
        print(f'PASS {len(self.results)} real integration groups', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--only', choices=['schema', 'client_denials', 'auth_denials', 'bookings', 'avatar', 'rls', 'concurrency'])
    args = parser.parse_args()
    probe = Probe(args.directory)
    if args.only:
        getattr(probe, args.only)()
    else:
        probe.run()
