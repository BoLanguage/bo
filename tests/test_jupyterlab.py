import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "jupyterlab"


def has_extension_dependencies():
    return shutil.which("npm") is not None and (EXTENSION / "node_modules").is_dir()


@unittest.skipUnless(has_extension_dependencies(), "needs JupyterLab extension npm dependencies")
class JupyterLabExtensionTests(unittest.TestCase):
    def test_extension_builds(self):
        environment = os.environ.copy()
        environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment["PATH"]
        result = subprocess.run(
            ["npm", "run", "build", "--prefix", str(EXTENSION)],
            cwd=ROOT, env=environment, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
