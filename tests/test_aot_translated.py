import unittest

from bench.aot.translate import translate


class TranslationInput(unittest.TestCase):
    def test_rejects_unsupported_source(self):
        for source in ("", "1", "(1) (X)", "(1) (X) POP",
                       "(1) (X) PUSH (2) (X) PUSH", "(1) (1 2) PUSH"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                translate(source)


if __name__ == "__main__":
    unittest.main()
