"""Real DaData suggestions with synthetic Telegram auth and in-memory local BB data.

Only the Deno child can contact DaData. Its network permissions allow that host
and loopback only. Browser/preview cannot contact production services.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode, urlsplit
from urllib.request import build_opener, ProxyHandler, Request
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests/bb75'))
from serve_mock import Handler, local_config, TG  # noqa: E402
from mock_api import MockAPI  # noqa: E402

ENV_PATH = Path.home() / '.config/beauty-booking/address-suggest.local.env'
EDGE = 'http://127.0.0.1:8077'
PREVIEW = 'http://127.0.0.1:8076'


def settings():
    if ENV_PATH.is_symlink() or ENV_PATH.resolve().is_relative_to(ROOT):
        raise ValueError('Private settings must be outside the repository')
    if stat.S_IMODE(ENV_PATH.stat().st_mode) != 0o600:
        raise ValueError('Private settings require permissions 600')
    values = dict(line.split('=', 1) for line in ENV_PATH.read_text().splitlines()
                  if line.strip() and not line.lstrip().startswith('#') and '=' in line)
    if not values.get('DADATA_API_KEY', '').strip() or values.get('DADATA_FREE_TIER_ENABLED') != 'true':
        raise ValueError('Configure the free DaData key in the private settings file')
    if not values.get('BOT_TOKEN', '').startswith('000000000:'):
        raise ValueError('Only generated synthetic local credentials are allowed')
    return values


def signature(values, token):
    secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
    data = '\n'.join(f'{key}={value}' for key, value in sorted(values.items()))
    return hmac.new(secret, data.encode(), hashlib.sha256).hexdigest()


def make_handler(token):
    fields = {'auth_date': str(int(time.time())),
              'user': json.dumps({'id': 202, 'first_name': 'Local test'}, separators=(',', ':'))}
    init_data = urlencode({**fields, 'hash': signature(fields, token)})
    # HMAC-signed test init_data is public to this local browser; the signing key is not.
    telegram = TG.replace("'bb75-invalid-mock-signature'", json.dumps(init_data))
    telegram = telegram.replace('id:101', 'id:202')
    telegram = telegram.replace("showPopup(p){alert('MOCK: '+p.message)}", 'showPopup(p){__popups.push(p.message)}')
    opener = build_opener(ProxyHandler({}))

    class LocalHandler(Handler):
        telegram_script = telegram
        api = MockAPI()

        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.headers.get('Host') not in ('127.0.0.1:8076', 'localhost:8076'):
                self.send('{}', status=403)
                return
            origin = self.headers.get('Origin')
            if origin and origin not in (PREVIEW, 'http://localhost:8076'):
                self.send('{}', status=403)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 16384:
                    self.send('{}', status=400)
                    return
                raw = self.rfile.read(length)
                body = json.loads(raw)
                from urllib.parse import parse_qsl
                if not isinstance(body, dict):
                    self.send('{}', status=400)
                    return
                try:
                    pairs = parse_qsl(body.get('init_data', ''), strict_parsing=True)
                except (ValueError, TypeError):
                    self.send('{}', status=401)
                    return
                values = dict(pairs)
                claimed = values.pop('hash', '')
                valid = (len(values) + 1 == len(pairs) and
                         hmac.compare_digest(signature(values, token), claimed) and
                         0 <= time.time() - int(values.get('auth_date', '0')) < 86400)
                if not valid:
                    self.send('{}', status=401)
                    return
                endpoint = self.path.removeprefix('/functions/v1/')
                if self.path == '/functions/v1/address-suggest':
                    req = Request(EDGE, data=raw, headers={'Content-Type': 'application/json'})
                    try:
                        with opener.open(req, timeout=6) as response:
                            self.send(response.read(131072).decode(), status=response.status)
                    except HTTPError as error:
                        self.send(error.read(4096).decode(), status=error.code)
                    except (URLError, TimeoutError, OSError):
                        self.send('{"error":{"code":"LOCAL_EDGE_UNAVAILABLE"}}', status=503)
                elif self.path.startswith('/functions/v1/') and endpoint in (
                    'catalog', 'master-profile', 'user-profile', 'slots-write', 'slots-read',
                    'bookings-read', 'booking-create', 'bookings-write', 'notify-master', 'notify-user',
                ):
                    with self.api_lock:
                        self.send(json.dumps(self.api.respond(endpoint, body), ensure_ascii=False))
                else:
                    self.send('{}', status=404)
            except (ValueError, TypeError, KeyError, AssertionError):
                self.send('{"error":{"code":"LOCAL_INVALID_REQUEST"}}', status=400)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return LocalHandler


def main():
    values = settings()
    local_config()  # Refuse to serve the real API config if replacement ever fails.
    deno = shutil.which('deno')
    if not deno:
        raise ValueError('Deno is required')
    for port in (8076, 8077):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    child = subprocess.Popen([
        deno, 'run', '--no-prompt', '--quiet',
        f'--allow-read={ROOT},{ENV_PATH}',
        '--allow-net=127.0.0.1:8077,suggestions.dadata.ru:443',
        str(ROOT / 'tools/local_address_edge.ts'), str(ENV_PATH),
    ], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server = None
    try:
        opener = build_opener(ProxyHandler({}))
        for _ in range(50):
            if child.poll() is not None:
                raise ValueError('Local Edge failed to start; no production fallback')
            try:
                with opener.open(Request(EDGE, method='OPTIONS'), timeout=.3):
                    break
            except (URLError, TimeoutError):
                time.sleep(.1)
        else:
            raise ValueError('Local Edge did not start')
        server = ThreadingHTTPServer(('127.0.0.1', 8076), make_handler(values['BOT_TOKEN']))
        print(f'LOCAL ONLY: {PREVIEW}. Real DaData; profile/slots in disposable memory.', flush=True)
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        server.serve_forever()
    finally:
        if server:
            server.server_close()
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        # Never render exception text, HTTP headers or subprocess output containing secrets.
        print('Local preview stopped. Check private settings and ports 8076/8077.', file=sys.stderr)
        sys.exit(1)
