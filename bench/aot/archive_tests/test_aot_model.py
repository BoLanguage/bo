import os
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bench.aot.run import ROOT, build_model


@unittest.skip("Archived AOT experiment: runtime hooks were removed; snapshot bench/EXECUTION_EXPERIMENTS.md")
@unittest.skipUnless(sys.platform == "linux" and platform.machine() == "x86_64"
                     and shutil.which(os.environ.get("CC", "cc")), "Linux x86-64 compiler required")
class AotModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.binary = Path(cls.directory.name) / "model"
        build_model(cls.binary)

    def run_model(self, mode, case, count, stats=False):
        env = os.environ.copy()
        for key in ("BO_NO_JIT", "BO_NO_NATIVE", "BO_NO_INTRINSICS", "BO_JIT_STATS",
                    "BO_AOT_MODEL_STATS"):
            env.pop(key, None)
        if stats:
            env["BO_AOT_MODEL_STATS"] = "1"
        return subprocess.run([self.binary, mode, case, str(count)], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=30)

    def test_workloads_match_runtime(self):
        for case, factor in (("calls", 1), ("rebind", 3), ("dynamic", 3)):
            for count in (1, 2, 17, 1000):
                for mode in ("model", "reference", "native"):
                    with self.subTest(case=case, count=count, mode=mode):
                        result = self.run_model(mode, case, count)
                        self.assertEqual((result.returncode, result.stdout.strip(), result.stderr),
                                         (0, str(count * factor), ""))

    def test_invalid_inputs(self):
        for case, count in (("calls", 0), ("calls", -1), ("calls", 10000001), ("unknown", 1)):
            result = self.run_model("model", case, count)
            self.assertEqual(result.returncode, 2)
            self.assertTrue(result.stderr)

    def test_dynamic_definitions_take_fallback(self):
        for case, expected in (("calls", 0), ("rebind", 0), ("dynamic", 17)):
            result = self.run_model("model", case, 17, stats=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr.strip(), f"BO_AOT_MODEL_STATS fallbacks={expected}")

    def test_dynamic_fallback_survives_collection_pressure(self):
        result = self.run_model("model", "dynamic", 500000, stats=True)
        self.assertEqual((result.returncode, result.stdout.strip(), result.stderr.strip()),
                         (0, "1500000", "BO_AOT_MODEL_STATS fallbacks=500000"))

    def test_fallback_dispatch_matches_runtime(self):
        for case, expected in (("number", "0 1 42"), ("empty", "0 1"),
                               ("step", "2"), ("add", "0 1 () 99")):
            with self.subTest(case=case):
                result = self.run_model("model", case, 1, stats=True)
                reference = self.run_model("reference", case, 1)
                self.assertEqual((result.returncode, result.stdout.strip()), (0, expected), result.stderr)
                self.assertEqual((result.returncode, result.stdout), (reference.returncode, reference.stdout))
                self.assertEqual(result.stderr.strip(), "BO_AOT_MODEL_STATS fallbacks=1")

    def test_fallback_reports_missing_word(self):
        for mode in ("model", "reference"):
            result = self.run_model(mode, "missing", 1)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Existence-Error", result.stderr)

    def test_runner(self):
        result = subprocess.run([sys.executable, str(ROOT / "bench/aot/model.py"),
                                 "--iterations", "30", "--repeat", "1"],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 12)


if __name__ == "__main__":
    unittest.main()
