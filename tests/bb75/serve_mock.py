"""Offline-only Mini App preview: python tests/bb75/serve_mock.py.

Binds loopback; serves a virtual config and index. Production files stay intact.
All state is disposable. This does not validate Telegram signatures or delivery.
"""
import json
import re
from threading import Lock
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from mock_api import MockAPI

ROOT = Path(__file__).resolve().parents[2] / 'webapp'
GUARD = """(() => {
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  if (url.origin !== location.origin) return Promise.reject(new Error('LOCAL_ONLY'));
  return nativeFetch(input, options);
};
window.open = () => { alert('MOCK: внешние ссылки отключены'); return null; };
document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (link && new URL(link.href, location.href).origin !== location.origin) event.preventDefault();
}, true);
})();"""
TG = """window.__tgCalls=[];window.__popups=[];window.Telegram={WebApp:{
initData:'bb75-invalid-mock-signature',initDataUnsafe:{user:{id:101,first_name:'Mock',username:'bb75_mock'}},
ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},
HapticFeedback:{impactOccurred(){}},showPopup(p){alert('MOCK: '+p.message)},
openTelegramLink(u){alert('MOCK link: '+u)}}};"""


def local_config():
    source = (ROOT / 'js/config.js').read_text()
    config, count = re.subn(r"supabase:\s*\{[^{}]*\}",
                           "supabase: {url: location.origin, key: 'bb75-mock-only'}", source)
    if count != 1 or re.search(r'https?://|sb_publishable_|sb_secret_', config):
        raise RuntimeError('Local configuration unavailable. Preview stopped; no production fallback.')
    return config


class Handler(SimpleHTTPRequestHandler):
    api = MockAPI()
    api_lock = Lock()
    telegram_script = TG

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; form-action 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'")
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send(self, content, content_type='application/json', status=200):
        data = content.encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        host = self.headers.get('Host', '').split(':')[0]
        if host not in ('127.0.0.1', 'localhost'):
            self.send('{}', status=403)
            return
        path = unquote(urlsplit(self.path).path)
        target = (ROOT / path.lstrip('/')).resolve()
        if not target.is_relative_to(ROOT) or '..' in Path(path).parts:
            self.send('{}', status=404)
            return
        if target == ROOT / 'js/config.js':
            try:
                self.send(local_config(), 'text/javascript')
            except (RuntimeError, OSError):
                self.send('throw new Error("Local configuration unavailable");', 'text/javascript', 503)
        elif path in ('/', '/index.html'):
            html = (ROOT / 'index.html').read_text()
            html = re.sub(r'<script src="https://[^\"]+"></script>', '', html)
            html = re.sub(r'<link\s+href="https://.*?>', '', html, flags=re.S)
            html = html.replace('<head>', '<head><script>'+GUARD+self.telegram_script+'</script>')
            self.send(html, 'text/html; charset=utf-8')
        elif target.is_file() and target.suffix in ('.js', '.css', '.png', '.svg', '.ico'):
            self.path = path
            super().do_GET()
        else:
            self.send('{}', status=404)

    def do_HEAD(self):
        self.send('{}', status=405)

    def do_POST(self):
        if (self.headers.get('Host', '').split(':')[0] not in ('localhost', '127.0.0.1')
                or not self.path.startswith('/functions/v1/')):
            self.send('{}', status=404)
            return
        payload = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        try:
            body = json.loads(payload) if 'application/json' in self.headers.get('Content-Type', '') else {}
            if not isinstance(body, dict):
                raise ValueError('Expected object')
            with self.api_lock:
                result = self.api.respond(self.path.rsplit('/', 1)[-1], body)
                content = json.dumps(result, ensure_ascii=False)
            self.send(content)
        except (AssertionError, KeyError, IndexError, StopIteration, ValueError, TypeError):
            self.send('{"error":{"code":"MOCK_UNSUPPORTED"}}', status=400)


if __name__ == '__main__':
    local_config()
    import sys
    import webbrowser
    http = ThreadingHTTPServer(('127.0.0.1', 8075), Handler)
    print('MOCK ONLY: http://127.0.0.1:8075. No Telegram authentication or delivery.', flush=True)
    if '--open' in sys.argv:
        webbrowser.open('http://127.0.0.1:8075')
    try:
        http.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        http.server_close()
