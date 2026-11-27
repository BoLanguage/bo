import sys
import unittest
from pathlib import Path

from python.bo.lower import lower_op_forms
from python.bo.values import Op

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import generate_adapters  # noqa: E402


class NamingConvention(unittest.TestCase):
    """Uppercase names are reserved for primitives, which are locked."""

    def selectors(self, path):
        items = [
            item for _, form in lower_op_forms(path.read_text(encoding="utf-8"))
            for item in form
        ]
        for unit, operation in zip(items, items[1:]):
            if (isinstance(unit, list) and len(unit) == 1 and isinstance(unit[0], Op)
                    and isinstance(operation, Op)):
                yield unit[0].name, operation.name

    def test_library_and_examples_do_not_name_stacks_like_primitives(self):
        primitives = set(generate_adapters.native_names())
        paths = [
            path for directory in ("include", "examples")
            for path in sorted((ROOT / directory).glob("*.bo"))
        ]
        self.assertGreater(len(paths), 10)
        for path in paths:
            for selector, operation in self.selectors(path):
                if operation in primitives:
                    with self.subTest(file=path.name, selector=selector, operation=operation):
                        self.assertNotIn(selector, primitives)

    def test_primitive_names_are_plain_uppercase_ops(self):
        for name in generate_adapters.native_names():
            with self.subTest(name=name):
                self.assertTrue(name.isalnum() and name.isupper(), name)


if __name__ == "__main__":
    unittest.main()
