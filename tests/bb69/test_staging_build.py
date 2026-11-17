"""Offline CLI checks: no project credentials or database are needed."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
TEST_URL = "https://abcdefghijklmnopqrst.supabase.co"
TEST_KEY = "sb_publishable_bb69_test_only"


class StagingBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        shutil.copytree(ROOT / "webapp", self.root / "webapp")
        (self.root / "scripts").mkdir()
        shutil.copyfile(ROOT / "scripts/build_staging_frontend.py",
                        self.root / "scripts/build_staging_frontend.py")
        self.before = self.snapshot(self.root / "webapp")

    def snapshot(self, directory):
        return {str(path.relative_to(directory)): path.read_bytes()
                for path in directory.rglob("*") if path.is_file()}

    def build(self, **variables):
        env = {k: v for k, v in os.environ.items() if not k.startswith("BB_SUPABASE_")}
        env.update(variables)
        return subprocess.run([sys.executable, str(self.root / "scripts/build_staging_frontend.py")],
                              env=env, capture_output=True, text=True)

    def test_isolated_bundle_and_unchanged_sources(self):
        (self.root / "webapp/.env").write_text("SERVICE_ROLE_KEY=not-for-browser")
        result = self.build(BB_SUPABASE_URL=TEST_URL, BB_SUPABASE_PUBLISHABLE_KEY=TEST_KEY,
                            SERVICE_ROLE_KEY="sb_secret_never_copy_environment")
        self.assertEqual(result.returncode, 0, result.stderr)
        bundle = self.snapshot(self.root / "dist-staging")
        self.assertEqual(set(bundle), set(self.before))
        for name, contents in self.before.items():
            if name != "js/config.js":
                self.assertEqual(bundle[name], contents, name)
        config = bundle["js/config.js"].decode()
        self.assertIn(TEST_URL, config)
        self.assertIn(TEST_KEY, config)
        all_bytes = b"\n".join(bundle.values())
        for marker in (b"bxzwfidujuejmrbqjmgo", b"sb_publishable_eQsfW9mYbM1i3Vhwr7h8ig_jM29E24C",
                       b"sb_secret_", b"SERVICE_ROLE_KEY"):
            self.assertNotIn(marker, all_bytes)
        after = self.snapshot(self.root / "webapp")
        for name, contents in self.before.items():
            self.assertEqual(after[name], contents)
        # Rebuild replaces output instead of keeping obsolete assets.
        (self.root / "dist-staging/stale.js").write_text("stale")
        self.assertEqual(self.build(BB_SUPABASE_URL=TEST_URL,
                                   BB_SUPABASE_PUBLISHABLE_KEY=TEST_KEY).returncode, 0)
        self.assertFalse((self.root / "dist-staging/stale.js").exists())

    def test_invalid_environment_fails_closed(self):
        valid = dict(BB_SUPABASE_URL=TEST_URL, BB_SUPABASE_PUBLISHABLE_KEY=TEST_KEY)
        cases = [{}, {"BB_SUPABASE_URL": TEST_URL}, {"BB_SUPABASE_PUBLISHABLE_KEY": TEST_KEY}]
        cases += [dict(valid, BB_SUPABASE_URL=url) for url in (
            "https://bxzwfidujuejmrbqjmgo.supabase.co",
            "https://BXZWFIDUJUEJMRBQJMGO.supabase.co", "http://abcdefghijklmnopqrst.supabase.co",
            TEST_URL + "/?key=sb_secret_bad", "https://user:password@abcdefghijklmnopqrst.supabase.co",
        )]
        cases += [dict(valid, BB_SUPABASE_PUBLISHABLE_KEY=key) for key in (
            "", "sb_secret_forbidden", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature",
            "sb_publishable_test';alert(1)//", "sb_publishable_eQsfW9mYbM1i3Vhwr7h8ig_jM29E24C",
        )]
        for variables in cases:
            with self.subTest(variables=variables):
                output = self.root / "dist-staging"
                output.mkdir(exist_ok=True)
                (output / "index.html").write_text("previous bundle")
                result = self.build(**variables)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
                self.assertEqual(self.snapshot(self.root / "webapp"), self.before)

    def test_copied_assets_cannot_reintroduce_existing_configuration_or_secret(self):
        for marker in ("bxzwfidujuejmrbqjmgo", "sb_secret_accidental_leak"):
            with self.subTest(marker=marker):
                (self.root / "webapp/js/accidental.js").write_text(f"// {marker}")
                result = self.build(BB_SUPABASE_URL=TEST_URL,
                                    BB_SUPABASE_PUBLISHABLE_KEY=TEST_KEY)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "dist-staging").exists())
                self.assertFalse(list(self.root.glob(".bb69-*")))


if __name__ == "__main__":
    unittest.main()
