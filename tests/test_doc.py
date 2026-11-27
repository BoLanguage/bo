import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import bodoc  # noqa: E402


class LibraryDocTests(unittest.TestCase):
    def test_generated_documents_are_up_to_date(self):
        for path, content in bodoc.render().items():
            with self.subTest(path=path.name):
                self.assertEqual(path.read_text(encoding="utf-8"), content,
                                 "run: python3 tools/bodoc.py")

    def test_library_inventory_has_adapters_and_derived_ops_but_hides_helpers(self):
        library = bodoc.LIBRARY_OUT.read_text(encoding="utf-8")
        self.assertIn("# Standard library", library)
        self.assertIn("### Stack", library)
        self.assertIn("| `snapshot` | primitive adapter |", library)
        self.assertIn("| `snapshot` | primitive adapter | `( -- L )`", library)
        self.assertIn("| `clear` | primitive adapter | `( -- )`", library)
        self.assertIn("| `unit` | primitive adapter |", library)
        self.assertIn("Wrap the top value in a one-element list.", library)
        self.assertNotIn("On `S`,", library)
        self.assertIn("| `foldl` | derived |", library)
        self.assertIn("| `+` | primitive adapter |", library)
        self.assertIn("| `.` | primitive adapter |", library)
        self.assertIn("| `loop` | primitive adapter | `( C B -- )`", library)
        self.assertIn("| `rethrow` | primitive adapter |", library)
        for helper in ("_lenacc", "_mapacc", "_ndig", "_pslines",
                       "_ucode"):
            self.assertNotIn(f"`{helper}`", library)
        self.assertNotIn("| `_", library)

    def test_primitive_inventory_is_metadata_driven(self):
        primitives = bodoc.PRIMITIVES_OUT.read_text(encoding="utf-8")
        self.assertIn("# Primitives", primitives)
        self.assertIn("#### Stack", primitives)
        self.assertIn("| `PUSH` | primitive |", primitives)
        self.assertIn("| `PUSH` | primitive | `D: (A s --), S: ( -- A)`", primitives)
        self.assertIn("| Name | Type | Effect | Stack | Description |", primitives)
        self.assertIn("| `PUSH` | primitive | `D: (A s --), S: ( -- A)` | "
                      "`D`<->`S` (cross-stack) | Push `A` from `D` onto `S`. |",
                      primitives)
        self.assertIn("| `EXISTS` | primitive |", primitives)
        self.assertIn("| `ADD` | primitive | `D: (s --), S: (A B -- C)`", primitives)
        self.assertIn("| `CLEAR` | primitive | `D: (s --), S: (... --)`", primitives)
        self.assertIn("| `MEDIAN` | primitive |", primitives)
        self.assertIn("| `ADD` | primitive | `D: (s --), S: (A B -- C)` | "
                      "`S` (named `s`) | On `S`, add `A` and `B`. |",
                      primitives)
        self.assertNotIn("| `unit` |", primitives)
        self.assertNotIn("| `ndig` |", primitives)
        self.assertIn("`S` is the stack selected by `s`", primitives)

    def test_inventory_sorts_groups_and_names(self):
        entries = [
            {"group": "Z", "name": "b", "type": "derived",
             "effect": "--", "description": "second"},
            {"group": "A", "name": "a", "type": "primitive",
             "effect": "--", "description": "first"},
            {"group": "Z", "name": "a", "type": "derived",
             "effect": "--", "description": "first"},
        ]
        rendered = bodoc.render_tables(entries)
        self.assertLess(rendered.index("### A"), rendered.index("### Z"))
        self.assertLess(rendered.index("| `a` | derived"), rendered.index("| `b` | derived"))

    def test_rendered_names_cover_each_inventory(self):
        primitive_entries, library_entries = bodoc.inventory()
        outputs = bodoc.render()
        for path, entries in (
            (bodoc.PRIMITIVES_OUT, primitive_entries),
            (bodoc.LIBRARY_OUT, library_entries),
        ):
            content = outputs[path]
            actual = set()
            for line in content.splitlines():
                if not line.startswith("| `"):
                    continue
                cells = [cell.strip() for cell in line.split("|")]
                if cells[2] in {"primitive", "primitive adapter", "derived"}:
                    actual.add(cells[1].strip("`"))
            self.assertEqual(actual, {entry["name"] for entry in entries})

    def test_derived_parser_ignores_helper_comments_without_effects(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            path = Path(directory) / "ops.bo"
            path.write_text(
                ";public ( L -- n ) count values\n"
                ";helper internal implementation detail\n"
                "; extra text\n"
            )
            self.assertEqual(
                bodoc.parse_derived(path),
                [{"name": "public", "group": "Ops", "type": "derived", "effect": "L -- n",
                  "description": "count values"}],
            )


if __name__ == "__main__":
    unittest.main()
