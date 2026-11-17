"""Offline package checks; never executes SQL or loads any credentials."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ExistingPackageTests(unittest.TestCase):
    def test_exact_selected_sources_and_no_baseline_or_seed(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/prepare_existing_upgrade.py')],
                                capture_output=True, text=True, check=True)
        directory = Path(result.stdout.strip())
        self.assertEqual(directory.parent, Path('/private/tmp'))
        self.addCleanup(shutil.rmtree, directory)
        manifest = json.loads((directory / 'manifest.json').read_text())
        self.assertEqual(manifest['project_ref'], 'bxzwfidujuejmrbqjmgo')
        files = manifest['migration_files']
        self.assertEqual(len(files), 11)  # read preflight + ten selected migrations
        for name, digest in files.items():
            self.assertEqual(hashlib.sha256((directory / name).read_bytes()).hexdigest(), digest)
            self.assertNotIn('baseline', name)
            self.assertFalse(name.endswith('20260930_bb.sql'))
            if name.startswith('migrations/'):
                self.assertEqual((directory / name).read_bytes(), (ROOT / 'supabase' / name).read_bytes())
        fixture = (directory / 'local-fixture.sql').read_text()
        self.assertIn('LOCAL SYNTHETIC FIXTURE ONLY', fixture)
        self.assertNotIn('insert into users', fixture.lower())
        self.assertEqual(hashlib.sha256(fixture.encode()).hexdigest(), manifest['local_fixture_sha256'])
        self.assertFalse(list(directory.rglob('*seed*')))


if __name__ == '__main__':
    unittest.main()
