import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/release'))
import backup
import preflight


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bundle = Path(self.temp.name) / 'bundle'
        backup.fixture(self.bundle)

    def test_restore_and_compare_every_byte(self):
        destination = Path(self.temp.name) / 'restored'
        backup.restore(self.bundle, destination)
        self.assertEqual(backup.verify(self.bundle), backup.verify(destination))
        for p in self.bundle.rglob('*'):
            if p.is_file():
                self.assertEqual(p.read_bytes(), (destination / p.relative_to(self.bundle)).read_bytes())

    def test_missing_required_components(self):
        for name in backup.REQUIRED:
            with self.subTest(name=name):
                path = self.bundle / name
                data = path.read_bytes()
                path.unlink()
                with self.assertRaises(ValueError):
                    backup.verify(self.bundle)
                path.write_bytes(data)

    def test_tampering(self):
        (self.bundle / 'postgres/data.sql').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def test_extra_file(self):
        (self.bundle / '.secret').write_text('fictional')
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def test_symlink(self):
        (self.bundle / 'link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def test_paths(self):
        for name in ['../outside', '/etc/passwd', 'a/../b', 'a//b', 'a\\b']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                backup.safe_file(self.bundle, name)

    def test_existing_destination_preserved(self):
        with self.assertRaises(ValueError):
            backup.restore(self.bundle, self.bundle)
        backup.verify(self.bundle)

    def test_nested_destination_rejected(self):
        with self.assertRaises(ValueError):
            backup.restore(self.bundle, self.bundle / 'nested')

    def test_manifest_counts(self):
        p = self.bundle / 'manifest.json'
        m = json.loads(p.read_text())
        m['counts']['auth_users'] = 0
        p.write_text(json.dumps(m))
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def rewrite_component(self, name, value):
        p = self.bundle / name
        p.write_text(json.dumps(value))
        mpath = self.bundle / 'manifest.json'
        manifest = json.loads(mpath.read_text())
        data = p.read_bytes()
        manifest['files'][name] = {'size': len(data), 'sha256': backup.digest(data)}
        mpath.write_text(json.dumps(manifest))

    def test_duplicate_storage_object(self):
        name = 'storage/inventory.json'
        inventory = json.loads((self.bundle / name).read_text())
        inventory['objects'] *= 2
        self.rewrite_component(name, inventory)
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def test_missing_storage_object(self):
        self.rewrite_component('storage/inventory.json', {'objects': []})
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def test_duplicate_auth_user(self):
        self.rewrite_component('auth/metadata.json', {'users': [{'id': 'fake'}, {'id': 'fake'}]})
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def test_real_bundle_rejected(self):
        p = self.bundle / 'manifest.json'
        m = json.loads(p.read_text())
        m['kind'] = 'production'
        p.write_text(json.dumps(m))
        with self.assertRaises(ValueError):
            backup.verify(self.bundle)

    def test_cli_redacts_bad_path(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tools/release/backup.py'),
                                 'verify', '/fictional-secret-marker'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('fictional-secret-marker', result.stderr)


class PreflightTests(unittest.TestCase):
    def edge_env(self):
        return dict(BOT_TOKEN='123456:fictional', BOT_USERNAME='fictional_bot',
                    SUPABASE_URL='https://fictional.test', SUPABASE_SECRET_KEYS='{"default":"sb_secret_fictional"}',
                    TELEGRAM_WEBHOOK_SECRET='x' * 32, WEB_APP_URL='https://app.test')

    def test_valid_env(self):
        self.assertEqual(preflight.check_env(self.edge_env(), 'edge'), [])

    def test_bot_database_credentials_required(self):
        env = self.edge_env()
        self.assertTrue(preflight.check_env(env, 'bot'))
        env['SUPABASE_KEY'] = 'sb_secret_fictional'
        self.assertEqual(preflight.check_env(env, 'bot'), [])

    def test_missing_each_env(self):
        env = self.edge_env()
        for key in env:
            bad = dict(env)
            del bad[key]
            with self.subTest(key=key):
                self.assertTrue(preflight.check_env(bad, 'edge'))

    def test_malformed_keys_redacted(self):
        for value in ['null', '[]', '{broken', '{"default":123}', '{"default":"sb_publishable_fictional"}']:
            env = self.edge_env() | {'SUPABASE_SECRET_KEYS': value}
            errors = preflight.check_env(env, 'edge')
            self.assertTrue(errors)
            self.assertNotIn(value, '\n'.join(errors))

    def test_url_rejections(self):
        for value in ['http://app.test', 'https://u:secret@app.test', 'https://app.test/?token=x', 'invalid']:
            self.assertFalse(preflight.url_ok(value))

    def test_frontend_secret_rejected(self):
        env = {'BB_SUPABASE_URL': 'https://fictional.test',
               'BB_SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_fictional-key'}
        self.assertEqual(preflight.check_env(env, 'frontend'), [])
        self.assertTrue(preflight.check_env(env | {'VITE_OTHER': 'sb_secret_fictional'}, 'frontend'))

    def test_integrated_edge_has_no_blockers(self):
        self.assertEqual(preflight.check_edge(ROOT), [])

    def test_missing_locks_and_unpinned_import_still_block(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copytree(ROOT / 'supabase', root / 'supabase')
            (root / 'supabase/functions/notify-master/deno.lock').unlink()
            source = root / 'supabase/functions/notify-user/index.ts'
            source.write_text(source.read_text().replace(
                "'@supabase/supabase-js'", "'npm:@supabase/supabase-js@2'"))
            errors = preflight.check_edge(root)
            self.assertIn('notify-master: missing deno.lock', errors)
            self.assertIn('notify-user: unpinned npm import', errors)

    def test_wasm_change_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'supabase/functions/master-avatar/vendor').mkdir(parents=True)
            (root / 'supabase/config.toml').write_text('[functions.master-avatar]\nverify_jwt=false\n')
            errors = preflight.check_edge(root)
            self.assertIn('master-avatar: WASM checksum mismatch', errors)
            self.assertIn('master-avatar: WASM not included in static_files', errors)


if __name__ == '__main__':
    unittest.main()
