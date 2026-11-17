"""Offline production artifact preparation. Does not connect, publish or deploy."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'dist-production'
PROJECT = 'bxzwfidujuejmrbqjmgo'
URL = f'https://{PROJECT}.supabase.co'
EXTENSIONS = {'.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.gif',
              '.webp', '.ico', '.woff', '.woff2', '.ttf'}


def build():
    if OUTPUT.is_symlink():
        raise ValueError('Output directory must not be a symlink')
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    if os.environ.get('VERCEL_ENV') not in (None, 'production'):
        raise ValueError('Production builder must not run in Preview or Development')
    # Independent of staging variables. There is deliberately no URL override.
    key = os.environ.get('BB_PRODUCTION_PUBLISHABLE_KEY', '')
    if not re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key):
        raise ValueError('A publishable key is required; secret/JWT keys are forbidden')
    maintenance = os.environ.get('BB_PRODUCTION_MAINTENANCE', 'true')
    if maintenance not in ('true', 'false'):
        raise ValueError('Maintenance must be true or false')
    source = ROOT / 'webapp'
    files = {}
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source)
        if path.is_symlink():
            raise ValueError('Symlinks are forbidden in frontend source')
        if not path.is_file() or any(part.startswith('.') for part in relative.parts):
            continue
        if path.suffix.lower() in EXTENSIONS:
            files[relative.as_posix()] = path.read_bytes()
    config = files['js/config.js'].decode()
    pattern = r"supabase:\s*\{\s*url:\s*'([^']+)',\s*key:\s*'([^']+)'\s*\}"
    if len(re.findall(pattern, config)) != 1:
        raise ValueError('Expected exactly one Supabase configuration')
    config = re.sub(pattern, lambda _: 'supabase: {url: ' + json.dumps(URL)
                    + ', key: ' + json.dumps(key) + '}', config)
    files['js/config.js'] = config.encode()
    for contents in files.values():
        if re.search(rb'sb_secret_|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', contents):
            raise ValueError('Secret or JWT marker found in frontend source')
        refs = re.findall(rb'https://([a-z0-9]{20})\.supabase\.co', contents)
        if any(ref.decode() != PROJECT for ref in refs):
            raise ValueError('Foreign Supabase project found in frontend source')
    # Content hash changes with every asset/config/loader change, not host time.
    boot_template = """import { createReleaseGate } from './release-gate.js';
function block(message) {
    const text = document.createElement('p');
    text.textContent = message;
    text.setAttribute('role', 'alert');
    document.body.replaceChildren(text);
}
const gate = createReleaseGate({release: RELEASE, projectUrl: PROJECT_URL,
    fetchImpl: globalThis.fetch.bind(globalThis), block});
globalThis.fetch = gate.fetch;
const recheck = () => gate.check().catch(() => {});
globalThis.addEventListener('pageshow', recheck);
globalThis.addEventListener('focus', recheck);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheck();
});
try {
    await gate.check();
    if (!globalThis.Telegram?.WebApp?.initData) {
        block('Откройте Mini App через Telegram.');
    } else {
        await import('./app.js');
    }
} catch {
    block('Не удалось загрузить приложение. Закройте Mini App и откройте его заново через Telegram.');
}
"""
    digest = hashlib.sha256(boot_template.encode())
    for name, contents in sorted(files.items()):
        digest.update(name.encode() + b'\0' + contents + b'\0')
    release = digest.hexdigest()[:20]
    prefix = f'releases/{release}'
    index = files.pop('index.html').decode()
    for old, new in [('src="js/app.js"', f'src="{prefix}/js/boot.js"'),
                     ('href="css/styles.css"', f'href="{prefix}/css/styles.css"')]:
        if index.count(old) != 1:
            raise ValueError('Expected frontend entrypoint is missing or duplicated')
        index = index.replace(old, new)
    # New clients use fetch-based Edge APIs; remove the unused floating SDK script.
    index = index.replace('    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n', '')
    files['js/boot.js'] = boot_template.replace('RELEASE', json.dumps(release)).replace('PROJECT_URL', json.dumps(URL)).encode()
    with tempfile.TemporaryDirectory(prefix='.bb73-build-', dir=ROOT) as temporary:
        bundle = Path(temporary)
        for name, contents in files.items():
            target = bundle / prefix / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
        (bundle / 'index.html').write_text(index)
        (bundle / 'release.json').write_text(json.dumps({'release': release, 'maintenance': maintenance == 'true'}) + '\n')
        manifest = {str(p.relative_to(bundle)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sorted(bundle.rglob('*')) if p.is_file()}
        (bundle / 'artifact-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        bundle.rename(OUTPUT)
    return release


if __name__ == '__main__':
    try:
        release = build()
    except (ValueError, OSError, KeyError) as error:
        # Never include supplied key values or environment dumps in errors.
        print(f'Production artifact preparation failed: {type(error).__name__}', file=sys.stderr)
        sys.exit(1)
    print(f'Production artifact prepared locally: dist-production/, release {release}')
