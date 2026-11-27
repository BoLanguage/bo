import json
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
JUPYTER_LANGUAGE = ROOT / "jupyterlab" / "src" / "generated.ts"


class VSCodePrimitiveGrammar(unittest.TestCase):
    def test_generated_runtime_syntax_artifacts_are_current(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "generate_vscode_grammar.py"), "--check"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_jupyter_language_data_contains_runtime_ops(self):
        source = JUPYTER_LANGUAGE.read_text()
        for op in ('"PARALLEL"', '"MATMUL"', '"parallel"',
                     'export const primitiveNames', '"PUSH"'):
            with self.subTest(op=op):
                self.assertIn(op, source)

    def test_primitive_actions_and_adapters_are_highlighted_as_ops(self):
        grammar = json.loads((ROOT / "vscode/syntaxes/bo.tmLanguage.json").read_text())
        for rule, op in (("adapter", "unit"), ("adapter", "call"), ("adapter", "rethrow"),
                           ("adapter", "snapshot")):
            pattern = grammar["repository"][rule]["match"]
            self.assertIsNotNone(re.fullmatch(pattern, op))
            self.assertIsNone(re.fullmatch(pattern, op + "suffix"))
        self.assertIsNone(re.fullmatch(grammar["repository"]["adapter"]["match"], "PUSH"))
        self.assertIsNotNone(re.fullmatch(grammar["repository"]["primitive"]["match"], "PUSH"))
        adapter_pattern = grammar["repository"]["adapter"]["match"]
        pattern = grammar["repository"]["primitive"]["match"]
        for op in ("PUSH", "UNIT", "CALL", "RETHROW"):
            self.assertIsNotNone(re.fullmatch(pattern, op))
            self.assertIsNone(re.fullmatch(adapter_pattern, op))
        for op in ("Stack.PUSH", "List.UNIT"):
            match = re.search(pattern, op)
            self.assertIsNotNone(match)
            self.assertEqual(match.group(), op.rsplit(".", 1)[1])
        self.assertIsNone(re.search(pattern, "PUSHED"))

    def test_error_pattern_matches_only_error_kinds_written_as_units(self):
        grammar = json.loads((ROOT / "vscode/syntaxes/bo.tmLanguage.json").read_text())
        self.assertNotIn("class", grammar["repository"])
        pattern = grammar["repository"]["error"]["match"]
        for op in ("(Type-Error)", "( Domain-Error )", "(Shape-Error)"):
            self.assertIsNotNone(re.fullmatch(pattern, op), op)
        for op in ("Type-Error", "(Disk-Full)", "(Type-Errors)", "(Stack.Type-Error)"):
            self.assertIsNone(re.fullmatch(pattern, op), op)


def has_textmate():
    if not NODE:
        return False
    result = subprocess.run(
        [NODE, "-e", "require.resolve('vscode-textmate'); require.resolve('vscode-oniguruma')"],
        cwd=ROOT / "vscode", capture_output=True, text=True,
    )
    return result.returncode == 0


@unittest.skipUnless(has_textmate(), "needs node, vscode-textmate and vscode-oniguruma")
class VSCodeGrammar(unittest.TestCase):
    def test_comment_scopes(self):
        result = subprocess.run([NODE, str(ROOT / "tests" / "vscode_grammar.js")],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("comment scopes: OK", result.stdout)
