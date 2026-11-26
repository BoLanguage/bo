"""Compare example output from the command-line runtimes with fixtures.

Programs run with the repository root as working directory. If examples/expected/NAME.in
exists it is fed to standard input. The C runtime is checked too when c/bo is built.
Regenerate an expected file only after checking the output by hand:
    python -m tests.test_examples --update
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES = os.path.join(ROOT, "examples")
EXPECTED = os.path.join(EXAMPLES, "expected")
C_BIN = os.path.join(ROOT, "c", "bo")
HELPER_OUTPUT = ("(3 (b C) a)\n(a)\n(a (b C) 3)\n()\n6\n6\n17\n1\n7\n"
                 "Representation-Error\n")


def programs():
    return sorted(f[:-3] for f in os.listdir(EXAMPLES) if f.endswith(".bo") and f != "lib.bo")


def run(cmd, name, directory="examples", env=None):
    stdin_path = os.path.join(EXPECTED, name + ".in")
    stdin = open(stdin_path, "rb") if os.path.exists(stdin_path) else subprocess.DEVNULL
    try:
        return subprocess.run(cmd + [os.path.join(directory, name + ".bo")], cwd=ROOT, stdin=stdin,
                              capture_output=True, text=True, timeout=120, env=env)
    finally:
        if stdin is not subprocess.DEVNULL:
            stdin.close()


class Examples(unittest.TestCase):
    def check(self, cmd, name):
        expected_path = os.path.join(EXPECTED, name + ".out")
        with open(expected_path, encoding="utf-8") as f:
            expected = f.read()
        result = run(cmd, name)
        self.assertEqual(result.stderr, "", name)
        self.assertEqual(result.stdout, expected, name)
        self.assertEqual(result.returncode, 0, name)


def add_tests():
    for name in programs():
        def python_test(self, name=name):
            self.check([sys.executable, "-m", "python.bo"], name)

        def c_test(self, name=name):
            self.check([C_BIN], name)

        setattr(Examples, "test_python_" + name.replace("-", "_"), python_test)
        setattr(Examples, "test_c_" + name.replace("-", "_"),
                unittest.skipUnless(os.path.exists(C_BIN), "c/bo is not built")(c_test))


add_tests()


class WordPythonExamples(unittest.TestCase):
    def test_examples(self):
        for name in programs():
            with self.subTest(example=name):
                with open(os.path.join(EXPECTED, name + ".out"), encoding="utf-8") as file:
                    expected = file.read()
                result = run([sys.executable, "-m", "tests.word_example_runner"], name)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertEqual(result.stdout, expected)

    def test_helpers_preserve_words_and_encoded_keys(self):
        check_helpers(self, [sys.executable, "-m", "tests.word_example_runner"])


def check_helpers(test, command, env=None):
    result = subprocess.run(
        command + [os.path.join(ROOT, "tests", "word_example_helpers.bo")],
        cwd=ROOT, capture_output=True, text=True, timeout=30, env=env,
    )
    test.assertEqual(result.returncode, 0, result.stderr)
    test.assertEqual(result.stderr, "")
    test.assertEqual(result.stdout, HELPER_OUTPUT)


@unittest.skipUnless(shutil.which("cc"), "C compiler not available")
class WordCExamples(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.binary = os.path.join(cls.temp.name, "bo-word-examples")
        sources = ["machine.c", "heap.c", "units.c", "words.c", "lower.c", "lineedit.c"]
        build = subprocess.run(
            ["cc", "-O2", "-g", "-Wall", "-Wextra", "-std=gnu11",
             "-I", os.path.join(ROOT, "c"),
             os.path.join(ROOT, "tests", "c_word_example_runner.c"),
             *(os.path.join(ROOT, "c", source) for source in sources),
             "-lm", "-o", cls.binary], capture_output=True, text=True,
        )
        if build.returncode:
            cls.temp.cleanup()
            raise RuntimeError(build.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_examples(self):
        for name in programs():
            with open(os.path.join(EXPECTED, name + ".out"), encoding="utf-8") as file:
                expected = file.read()
            commands = []
            for mode, variable in (("generic-ops", "BO_NO_OP_OPTIMIZATIONS"),
                                   ("specialized-ops", None)):
                env = os.environ.copy()
                for key in ("BO_NO_OP_OPTIMIZATIONS",):
                    env.pop(key, None)
                if variable:
                    env[variable] = "1"
                commands.append((mode, [self.binary, os.path.join(ROOT, "include", "core.bo")], env))
            for mode, command, env in commands:
                with self.subTest(example=name, mode=mode):
                    result = run(command, name, env=env)
                    self.assertEqual(result.returncode, 0, (name, command, result.stderr))
                    self.assertEqual(result.stderr, "", name)
                    self.assertEqual(result.stdout, expected, name)

    def test_helpers_preserve_words_and_encoded_keys(self):
        for mode, variable in (("generic-ops", "BO_NO_OP_OPTIMIZATIONS"),
                               ("specialized-ops", None)):
            with self.subTest(mode=mode):
                env = os.environ.copy()
                for key in ("BO_NO_OP_OPTIMIZATIONS",):
                    env.pop(key, None)
                if variable:
                    env[variable] = "1"
                check_helpers(self, [self.binary, os.path.join(ROOT, "include", "core.bo")], env)

if __name__ == "__main__":
    if "--update" in sys.argv:
        for name in programs():
            out = run([sys.executable, "-m", "bo"], name)
            if out.returncode or out.stderr:
                raise RuntimeError(f"{name} failed: {out.stderr}")
            with open(os.path.join(EXPECTED, name + ".out"), "w", encoding="utf-8") as f:
                f.write(out.stdout)
            print(name, "ok" if out.returncode == 0 and not out.stderr else "FAILED")
    else:
        unittest.main()
