import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class VersionSync(unittest.TestCase):
    def test_package_versions_follow_the_version_file(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "sync_version.py"), "--check"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_extensions_carry_the_current_version(self):
        number = (ROOT / "VERSION").read_text(encoding="utf-8").split()[0]
        for package in ("vscode", "jupyterlab"):
            with self.subTest(package=package):
                manifest = json.loads((ROOT / package / "package.json").read_text())
                self.assertEqual(manifest["version"], number)
                lock = json.loads((ROOT / package / "package-lock.json").read_text())
                self.assertEqual(lock["version"], number)
                self.assertEqual(lock["packages"][""]["version"], number)


if __name__ == "__main__":
    unittest.main()
