"""Build the isolated static frontend with Python's standard library only."""

import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist-staging"
BLOCKED_PROJECT = "bxzwfidujuejmrbqjmgo"
PUBLIC_EXTENSIONS = {".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".svg",
                     ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf"}


def build():
    # A failed rebuild must not leave an older, deployable bundle behind.
    if OUTPUT.is_symlink():
        raise ValueError("Output directory must not be a symlink")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)

    url = os.environ.get("BB_SUPABASE_URL", "")
    key = os.environ.get("BB_SUPABASE_PUBLISHABLE_KEY", "")
    if not url or not key:
        raise ValueError("BB_SUPABASE_URL and BB_SUPABASE_PUBLISHABLE_KEY are required")
    if BLOCKED_PROJECT in (url + key).lower():
        raise ValueError("Existing Supabase project is forbidden in staging")
    if not re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", url):
        raise ValueError("BB_SUPABASE_URL must be an HTTPS Supabase project URL")
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key):
        raise ValueError("Only sb_publishable_ keys are allowed; secret/JWT keys are forbidden")

    source = ROOT / "webapp"
    config = (source / "js/config.js").read_text(encoding="utf-8")
    pattern = r"supabase:\s*\{\s*url:\s*'([^']+)',\s*key:\s*'([^']+)'\s*\}"
    original = re.findall(pattern, config)
    if len(original) != 1:
        raise ValueError("Expected exactly one Supabase configuration")
    if key == original[0][1]:
        raise ValueError("Existing Supabase key is forbidden in staging")
    config = re.sub(pattern, lambda _: "supabase: {\n        url: " + json.dumps(url)
                    + ",\n        key: " + json.dumps(key) + "\n    }", config)

    with tempfile.TemporaryDirectory(prefix=".bb69-", dir=ROOT) as temporary:
        bundle = Path(temporary)
        for path in source.rglob("*"):
            relative = path.relative_to(source)
            if path.is_symlink():
                raise ValueError("Symlinks are forbidden in the frontend source")
            if not path.is_file() or any(part.startswith(".") for part in relative.parts):
                continue
            if path.suffix.lower() not in PUBLIC_EXTENSIONS:
                continue
            target = bundle / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if relative.as_posix() == "js/config.js":
                target.write_text(config, encoding="utf-8")
            else:
                shutil.copyfile(path, target)
            contents = target.read_bytes()
            if any(marker in contents for marker in (
                BLOCKED_PROJECT.encode(), original[0][1].encode(), b"sb_secret_",
            )):
                raise ValueError("Forbidden Supabase configuration found in bundle")
        bundle.rename(OUTPUT)


if __name__ == "__main__":
    try:
        build()
    except (ValueError, OSError) as error:
        print(f"Staging build failed: {error}", file=sys.stderr)
        sys.exit(1)
    print("Staging frontend built: dist-staging/")
