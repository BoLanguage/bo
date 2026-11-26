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

    def test_jupyter_language_data_contains_runtime_words(self):
        source = JUPYTER_LANGUAGE.read_text()
        for word in ('"PARALLEL"', '"MATMUL"', '"parallel"',
                     'export const primitiveNames', '"PUSH"'):
            with self.subTest(word=word):
                self.assertIn(word, source)

    def test_primitive_actions_and_adapters_are_highlighted_as_words(self):
        grammar = json.loads((ROOT / "vscode/syntaxes/bo.tmLanguage.json").read_text())
        for rule, word in (("adapter", "unit"), ("adapter", "call"), ("adapter", "rethrow"),
                           ("adapter", "snapshot")):
            pattern = grammar["repository"][rule]["match"]
            self.assertIsNotNone(re.fullmatch(pattern, word))
            self.assertIsNone(re.fullmatch(pattern, word + "suffix"))
        self.assertIsNone(re.fullmatch(grammar["repository"]["adapter"]["match"], "PUSH"))
        self.assertIsNotNone(re.fullmatch(grammar["repository"]["primitive"]["match"], "PUSH"))
        adapter_pattern = grammar["repository"]["adapter"]["match"]
        pattern = grammar["repository"]["primitive"]["match"]
        for word in ("PUSH", "UNIT", "CALL", "RETHROW"):
            self.assertIsNotNone(re.fullmatch(pattern, word))
            self.assertIsNone(re.fullmatch(adapter_pattern, word))
        for word in ("Stack.PUSH", "List.UNIT"):
            match = re.search(pattern, word)
            self.assertIsNotNone(match)
            self.assertEqual(match.group(), word.rsplit(".", 1)[1])
        self.assertIsNone(re.search(pattern, "PUSHED"))

    def test_error_pattern_matches_only_error_kinds_written_as_units(self):
        grammar = json.loads((ROOT / "vscode/syntaxes/bo.tmLanguage.json").read_text())
        self.assertNotIn("class", grammar["repository"])
        pattern = grammar["repository"]["error"]["match"]
        for word in ("(Type-Error)", "( Domain-Error )", "(Shape-Error)"):
            self.assertIsNotNone(re.fullmatch(pattern, word), word)
        for word in ("Type-Error", "(Disk-Full)", "(Type-Errors)", "(Stack.Type-Error)"):
            self.assertIsNone(re.fullmatch(pattern, word), word)


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
