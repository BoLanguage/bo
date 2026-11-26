import contextlib
import io
import json
import unittest
from pathlib import Path

from python.bo.machine import Machine


ROOT = Path(__file__).resolve().parent.parent
NOTEBOOKS = ROOT / "examples" / "notebooks"
EXPECTED = ROOT / "examples" / "expected"


class ExampleNotebookTests(unittest.TestCase):
    def test_notebooks_execute_like_their_source_examples(self):
        for path in sorted(NOTEBOOKS.glob("*.ipynb")):
            with self.subTest(path=path.name):
                notebook = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(notebook["nbformat"], 4)
                self.assertEqual(notebook["metadata"]["kernelspec"]["name"], "bo")
                machine = Machine()
                output = io.StringIO()
                errors = io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    self.assertTrue(machine.include_file("include/core.bo"))
                    for cell in notebook["cells"]:
                        if cell["cell_type"] == "code":
                            self.assertTrue(
                                machine.execute("".join(cell["source"]), path.name),
                                errors.getvalue(),
                            )
                expected = (EXPECTED / f"{path.stem}.out").read_text(encoding="utf-8")
                self.assertEqual(output.getvalue(), expected)
                self.assertEqual(errors.getvalue(), "")
