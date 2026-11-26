import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "bench" / "compare" / "run.py"
MIGRATION = ROOT / "bench" / "compare" / "migration.py"
MICRO = ROOT / "bench" / "compare" / "micro.py"
ARRAY_PARALLEL = ROOT / "bench" / "array_parallel.py"


class BenchmarkRunner(unittest.TestCase):
    def test_invalid_repeat_is_rejected(self):
        result = subprocess.run([sys.executable, str(RUNNER), "--repeat", "0"],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--repeat must be positive", result.stderr)

    def test_failed_runtime_is_not_reported_as_a_measurement(self):
        result = subprocess.run([sys.executable, str(RUNNER), "--binary", "/bin/false"],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exit=1", result.stderr)
        self.assertNotIn("median=", result.stdout)

    def test_unknown_workload_is_rejected(self):
        result = subprocess.run([sys.executable, str(RUNNER), "--workload", "missing"],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid choice", result.stderr)

    @unittest.skipUnless((ROOT / "c/bo").exists(), "c/bo is not built")
    def test_selected_workload_compares_modes(self):
        result = subprocess.run(
            [sys.executable, str(RUNNER), "--workload", "fib", "--repeat", "1",
             "--compare-generic"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("specialized median=", lines[0])
        self.assertIn("generic median=", lines[1])
        for line in lines:
            self.assertIn("result=2178309", line)

    def test_investigation_runners_reject_invalid_repeat(self):
        for runner, extra in ((MIGRATION, ["--legacy-root", str(ROOT)]), (MICRO, [])):
            with self.subTest(runner=runner):
                result = subprocess.run([sys.executable, str(runner), *extra, "--repeat", "0"],
                                        capture_output=True, text=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("--repeat must be positive", result.stderr)

    def test_micro_runner_rejects_failed_runtime(self):
        result = subprocess.run([sys.executable, str(MICRO), "--binary", "/bin/false",
                                 "--repeat", "1"],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exit=1", result.stderr)
        self.assertNotIn("median=", result.stdout)

    @unittest.skipUnless((ROOT / "c/bo").exists(), "c/bo is not built")
    def test_array_parallel_runner_validates_and_measures(self):
        result = subprocess.run(
            [sys.executable, str(ARRAY_PARALLEL), "--sizes", "10",
             "--chunks", "1", "--runs", "1"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("rank-one array broadcast length 10:", result.stdout)
        self.assertIn("rank-one array sum length 10:", result.stdout)
        self.assertIn("rank-one array sum-pipeline depth 1 length 10:", result.stdout)
        self.assertIn("rank-one array dot length 10:", result.stdout)
        self.assertIn("rank-one array dot-pipeline depth 1 length 10:", result.stdout)
        self.assertIn("rank-one array prod length 10:", result.stdout)
        self.assertIn("rank-one array min length 10:", result.stdout)
        self.assertIn("rank-one array any-early length 10:", result.stdout)
        self.assertIn("rank-one array all-late length 10:", result.stdout)
        self.assertIn("chunks=1", result.stdout)
        self.assertIn("speedup", result.stdout)

    def test_archived_native_runners_refuse_current_runtime(self):
        for name in ("jit.py", "tiers.py", "native_heavy.py"):
            with self.subTest(runner=name):
                result = subprocess.run([sys.executable, str(ROOT / "bench/compare" / name)],
                                        capture_output=True, text=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires the restored native-JIT runtime", result.stderr)
                self.assertNotIn("median=", result.stdout)

    @unittest.skipUnless((ROOT / "c/bo").exists(), "c/bo is not built")
    def test_collatz_variants_across_execution_modes(self):
        total = 0
        for value in range(2, 101):
            while value > 1:
                value = value // 2 if value % 2 == 0 else 3 * value + 1
                total += 1
        for name in ("collatz", "collatz-rec"):
            source = (ROOT / "bench/compare" / f"{name}.bo").read_text(encoding="utf-8")
            source = source.replace('"../../include/std.bo"', '"include/std.bo"').replace("30001", "101")
            for mode in (None, "BO_NO_OP_OPTIMIZATIONS"):
                with self.subTest(name=name, mode=mode):
                    env = os.environ.copy()
                    for key in ("BO_NO_OP_OPTIMIZATIONS",):
                        env.pop(key, None)
                    if mode:
                        env[mode] = "1"
                    result = subprocess.run([str(ROOT / "c/bo"), "-e", source], cwd=ROOT,
                                            env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual((result.returncode, result.stdout.strip(), result.stderr),
                                     (0, str(total), ""))


if __name__ == "__main__":
    unittest.main()
