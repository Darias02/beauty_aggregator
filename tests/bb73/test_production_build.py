"""Offline artifact checks with fake publishable keys; never calls Supabase."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
KEY = 'sb_publishable_bb73_fake_only'


class ProductionBuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        shutil.copytree(ROOT / 'webapp', self.root / 'webapp')
        (self.root / 'scripts').mkdir()
        shutil.copyfile(ROOT / 'scripts/build_production_frontend.py', self.root / 'scripts/build_production_frontend.py')

    def build(self, key=KEY, maintenance=None, hosting=None):
        env = {k: v for k, v in os.environ.items()
               if k not in ('BB_PRODUCTION_PUBLISHABLE_KEY', 'BB_PRODUCTION_MAINTENANCE', 'VERCEL_ENV')}
        if key is not None:
            env['BB_PRODUCTION_PUBLISHABLE_KEY'] = key
        env['BB_SUPABASE_URL'] = 'https://foreignforeignforeig.supabase.co'
        env['SUPABASE_SERVICE_ROLE_KEY'] = 'sb_secret_do_not_copy'
        if maintenance is not None:
            env['BB_PRODUCTION_MAINTENANCE'] = maintenance
        if hosting is not None:
            env['VERCEL_ENV'] = hosting
        return subprocess.run([sys.executable, str(self.root / 'scripts/build_production_frontend.py')],
                              env=env, text=True, capture_output=True)

    def snapshot(self):
        return {str(p.relative_to(self.root / 'webapp')): p.read_bytes()
                for p in (self.root / 'webapp').rglob('*') if p.is_file()}

    def test_pinned_project_public_config_immutable_source_and_complete_manifest(self):
        before = self.snapshot()
        (self.root / 'webapp/.env').write_text('sb_secret_hidden')
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.root / 'dist-production'
        state = json.loads((output / 'release.json').read_text())
        self.assertTrue(state['maintenance'])
        version = state['release']
        assets = output / 'releases' / version
        config = (assets / 'js/config.js').read_text()
        self.assertIn('https://bxzwfidujuejmrbqjmgo.supabase.co', config)
        self.assertIn(KEY, config)
        self.assertNotIn('sb_secret_', b'\n'.join(p.read_bytes() for p in output.rglob('*') if p.is_file()).decode())
        manifest = json.loads((output / 'artifact-manifest.json').read_text())
        actual = {str(p.relative_to(output)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in output.rglob('*') if p.is_file() and p.name != 'artifact-manifest.json'}
        self.assertEqual(manifest, actual)
        index = (output / 'index.html').read_text()
        self.assertIn(f'releases/{version}/js/boot.js', index)
        self.assertIn(f'releases/{version}/css/styles.css', index)
        self.assertIn('https://telegram.org/js/telegram-web-app.js', index)
        self.assertNotIn('supabase-js@2', index)
        boot = (assets / 'js/boot.js').read_text()
        self.assertLess(boot.index('await gate.check()'), boot.index("await import('./app.js')"))
        self.assertIn('Telegram?.WebApp?.initData', boot)
        for name, contents in before.items():
            self.assertEqual((self.root / 'webapp' / name).read_bytes(), contents)
        # Resolve the whole versioned ES module graph locally, including boot.
        for script in assets.rglob('*.js'):
            for dependency in re.findall(r"(?:from\s*|import\s*\()\s*['\"]([^'\"]+)", script.read_text()):
                if dependency.startswith('.'):
                    self.assertTrue((script.parent / dependency).resolve().is_file(), (script, dependency))
        (output / 'stale.js').write_text('old')
        self.assertEqual(self.build().returncode, 0)
        self.assertFalse((output / 'stale.js').exists())
        self.assertEqual(json.loads((output / 'release.json').read_text())['release'], version)
        (self.root / 'webapp/js/app.js').write_text(before['js/app.js'].decode() + '\n// new release\n')
        self.assertEqual(self.build().returncode, 0)
        self.assertNotEqual(json.loads((output / 'release.json').read_text())['release'], version)

    def test_missing_secret_jwt_or_invalid_key_removes_stale_artifact(self):
        for key in (None, '', 'sb_secret_forbidden', 'eyJhbGciOiJIUzI1NiJ9.e30.signature', "sb_publishable_a';alert(1)"):
            with self.subTest(key=key):
                output = self.root / 'dist-production'
                output.mkdir(exist_ok=True)
                (output / 'index.html').write_text('stale')
                result = self.build(key)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
                if key:
                    self.assertNotIn(key, result.stderr)

    def test_generated_boot_with_fake_dom_and_no_network(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.root / 'dist-production'
        version = json.loads((output / 'release.json').read_text())['release']
        result = subprocess.run(['deno', 'run', '--allow-read',
            str(ROOT / 'tests/bb73/check_production_boot.mjs'),
            str(output / 'releases' / version / 'js/boot.js')],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS emitted production boot', result.stdout)

    def test_opening_requires_explicit_mode_and_invalid_mode_fails_closed(self):
        self.assertEqual(self.build(maintenance='false').returncode, 0)
        output = self.root / 'dist-production'
        self.assertFalse(json.loads((output / 'release.json').read_text())['maintenance'])
        self.assertNotEqual(self.build(maintenance='yes').returncode, 0)
        self.assertFalse(output.exists())

    def test_preview_cannot_build_against_existing_project(self):
        for hosting in ('preview', 'development'):
            self.assertNotEqual(self.build(hosting=hosting).returncode, 0)
            self.assertFalse((self.root / 'dist-production').exists())
        self.assertEqual(self.build(hosting='production').returncode, 0)

    def test_public_asset_secret_and_foreign_project_are_rejected(self):
        for marker in ('sb_secret_leaked', 'eyJfake.e30.signature', 'https://abcdefghijklmnopqrst.supabase.co'):
            (self.root / 'webapp/js/accident.js').write_text(marker)
            self.assertNotEqual(self.build().returncode, 0)
            self.assertFalse((self.root / 'dist-production').exists())
        self.assertFalse(list(self.root.glob('.bb73-build-*')))

    def test_symlink_source_or_output_is_not_followed(self):
        target = self.root / 'outside.txt'
        target.write_text('keep')
        link = self.root / 'webapp/js/linked.js'
        link.symlink_to(target)
        self.assertNotEqual(self.build().returncode, 0)
        self.assertEqual(target.read_text(), 'keep')
        link.unlink()
        output = self.root / 'dist-production'
        output.symlink_to(self.root / 'webapp', target_is_directory=True)
        self.assertNotEqual(self.build().returncode, 0)
        self.assertTrue((self.root / 'webapp/index.html').exists())


if __name__ == '__main__':
    unittest.main()
