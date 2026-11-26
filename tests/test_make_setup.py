import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class MakeSetup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "make").symlink_to(shutil.which("make"))
        self.log = self.root / "calls"
        self.env = {
            **os.environ,
            "PATH": str(self.bin),
            "TEST_LOG": str(self.log),
            "MAKEFLAGS": "",
        }
        for name in ("cc", "python3", "git"):
            self.command(name, "exit 0")
        (self.bin / "node").symlink_to(shutil.which("node"))
        self.command("uv", """
echo "uv $*" >> "$TEST_LOG"
case " $* " in *" --check "*) [ "${MISSING_PYTHON:-0}" = 0 ] ;; *) exit 0 ;; esac
""")
        self.command("npm", """
echo "npm $*" >> "$TEST_LOG"
if [ "$1" = ls ] && [ "${MISSING_NPM:-0}" = 1 ]; then exit 1; fi
exit 0
""")
        (self.root / ".venv/bin").mkdir(parents=True)
        (self.root / ".venv/bin/python").touch()
        (self.root / "VERSION").write_text("0.1.0 2026-01-01\n")
        (self.root / "tools").mkdir()
        shutil.copy(ROOT / "tools/check_npm_lock.mjs", self.root / "tools")
        for directory in ("playground/vendor-src", "playground-plus", "jupyterlab", "vscode"):
            package = self.root / directory
            (package / "node_modules").mkdir(parents=True)
            lock = '{"packages":{"node_modules/example":{"version":"1.0.0"}}}'
            (package / "package-lock.json").write_text(lock)
            (package / "node_modules/.package-lock.json").write_text(lock)
        makefile = (ROOT / "Makefile").read_text()
        makefile += """
c wasm vendor jupyterlab vsix:
	@echo "build $@" >> "$$TEST_LOG"
emsdk:
	@echo "install emsdk" >> "$$TEST_LOG"
	@printf 'export PATH="%s:%s"\\n' "$(TEST_EMCC_DIR)" "$$PATH" > "$(EMSDK_ENV)"
"""
        (self.root / "Makefile").write_text(makefile)
        self.emcc_dir = self.root / "emcc"
        self.emcc_dir.mkdir()
        emcc = self.emcc_dir / "emcc"
        emcc.write_text("#!/bin/sh\nexit 0\n")
        emcc.chmod(0o755)
        self.env["TEST_EMCC_DIR"] = str(self.emcc_dir)
        self.env["EMSDK_ENV"] = str(self.root / "emsdk_env.sh")

    def command(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def run_make(self, *targets):
        return subprocess.run(
            [str(self.bin / "make"), *targets], cwd=self.root, env=self.env,
            text=True, capture_output=True, check=True,
        )

    def calls(self):
        return self.log.read_text().splitlines()

    def test_all_installs_missing_dependencies_before_building(self):
        self.env["MISSING_PYTHON"] = "1"
        self.env["MISSING_NPM"] = "1"
        self.run_make("-j2", "all")
        calls = self.calls()
        self.assertTrue(any(line.startswith("uv pip install --python") for line in calls))
        self.assertEqual(sum(line.startswith("npm install ") for line in calls), 4)
        self.assertIn("install emsdk", calls)
        self.assertLess(calls.index("install emsdk"), calls.index("build c"))
        self.assertEqual({line for line in calls if line.startswith("build ")},
                         {"build c", "build wasm", "build vendor", "build jupyterlab", "build vsix"})

    def test_existing_dependencies_and_emsdk_are_not_reinstalled(self):
        (self.root / "emsdk_env.sh").write_text(f'export PATH="{self.emcc_dir}:$PATH"\n')
        self.run_make("all")
        calls = self.calls()
        self.assertFalse(any(line.startswith("uv pip install --python") for line in calls))
        self.assertFalse(any(line.startswith("npm install ") for line in calls))
        self.assertNotIn("install emsdk", calls)
        self.assertIn("build wasm", calls)

    def test_broken_existing_emsdk_fails_instead_of_skipping_wasm(self):
        (self.root / "emsdk_env.sh").write_text("return 1\n")
        result = subprocess.run(
            [str(self.bin / "make"), "all"], cwd=self.root, env=self.env,
            text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not usable", result.stderr)
        self.assertFalse(any(line.startswith("build ") for line in self.calls()))

    def test_changed_lockfile_reinstalls_only_the_affected_package(self):
        (self.root / "emsdk_env.sh").write_text(f'export PATH="{self.emcc_dir}:$PATH"\n')
        lock = self.root / "playground-plus/package-lock.json"
        lock.write_text('{"packages":{"node_modules/example":{"version":"2.0.0"}}}')
        self.run_make("all")
        installs = [line for line in self.calls() if line.startswith("npm install ")]
        self.assertEqual(installs, ["npm install --prefix playground-plus"])


if __name__ == "__main__":
    unittest.main()
