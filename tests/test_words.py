import unittest

from python.bo.lower import LoweringError, lower_word_forms, valid_word_name
from python.bo.render import render
from python.bo.units import cons_unit, uncons_unit
from python.bo.values import BoError, Word, from_str
from python.bo.words import text_to_word, unit_type, word_to_text


class WordConversions(unittest.TestCase):
    def test_unit_type_does_not_evaluate_its_element(self):
        self.assertEqual(unit_type([42]), 0)
        self.assertEqual(unit_type([[1, 2]]), 1)
        self.assertEqual(unit_type([Word("OP")]), 2)
        for unit in ([], [1, 2], 42):
            with self.subTest(unit=unit), self.assertRaises(BoError) as error:
                unit_type(unit)
            self.assertEqual(error.exception.kind, "Type-Error")

    def test_round_trip(self):
        for name in ("OP", "op", "+", "@", "$", "NumPy.MATMUL", "π", "😀",
                     "١٢٣", "１２３", "1١", "١.2", "1e٢"):
            with self.subTest(name=name):
                text = from_str(name)
                unit = [Word(name)]
                self.assertEqual(text_to_word(text), unit)
                self.assertEqual(word_to_text(unit), text)
                self.assertTrue(valid_word_name(name))

    def test_at_renders_as_an_ordinary_word(self):
        self.assertEqual(render(Word("@")), "@")
        rendered = render([Word("@")])
        self.assertEqual(rendered, "(@)")
        self.assertEqual(lower_word_forms(rendered)[0][1], [[Word("@")]])

    def test_invalid_names_raise_representation_error(self):
        for name in ("", "a b", "a\nb", "a;b", "(OP)", '"OP"', "123", "1.5", "1e999",
                     "\0", "\ud800"):
            with self.subTest(name=repr(name)), self.assertRaises(BoError) as error:
                text_to_word(from_str(name))
            self.assertEqual(error.exception.kind, "Representation-Error")

    def test_out_of_range_code_points_raise_representation_error(self):
        for text in ([-1], [0x110000]):
            with self.subTest(text=text), self.assertRaises(BoError) as error:
                text_to_word(text)
            self.assertEqual(error.exception.kind, "Representation-Error")

    def test_invalid_internal_word_cannot_be_converted(self):
        for word in (Word("a b"), Word("123")):
            with self.subTest(word=word), self.assertRaises(BoError) as error:
                word_to_text([word])
            self.assertEqual(error.exception.kind, "Representation-Error")

    def test_non_text_and_non_word_units_raise_type_error(self):
        for text in (42, [65, []], [65.5]):
            with self.subTest(text=text), self.assertRaises(BoError) as error:
                text_to_word(text)
            self.assertEqual(error.exception.kind, "Type-Error")
        for unit in (Word("OP"), [], [1], [Word("OP"), Word("OP")], [[Word("OP")]]):
            with self.subTest(unit=unit), self.assertRaises(BoError) as error:
                word_to_text(unit)
            self.assertEqual(error.exception.kind, "Type-Error")


class WordLowering(unittest.TestCase):
    def test_words_are_single_elements_and_strings_remain_text(self):
        forms = lower_word_forms('(OP 1 2) "OP" OP @ $')
        self.assertEqual(
            [item for _, items in forms for item in items],
            [[Word("OP"), 1, 2], [79, 80], Word("OP"), Word("@"), Word("$")],
        )

    def test_nested_lists_preserve_words_and_source_lines(self):
        self.assertEqual(
            lower_word_forms('\n((A "x") 3)\nπ'),
            [(2, [[[Word("A"), [120]], 3]]), (3, [Word("π")])],
        )

    def test_invalid_source_names_and_numbers_are_rejected(self):
        for source in ("\0", "\ud800", "1e999"):
            with self.subTest(source=repr(source)), self.assertRaises(LoweringError):
                lower_word_forms(source)


class UnitListOperations(unittest.TestCase):
    def test_round_trip_at_both_ends(self):
        for element in (42, [1, 2], Word("OP")):
            for right in (False, True):
                with self.subTest(element=element, right=right):
                    rest = [3, 4]
                    original = rest + [element] if right else [element] + rest
                    actual_rest, unit = uncons_unit(original, right)
                    self.assertEqual((actual_rest, unit), (rest, [element]))
                    self.assertEqual(cons_unit(actual_rest, unit, right), original)
                    self.assertEqual(original, rest + [element] if right else [element] + rest)

    def test_invalid_operands(self):
        for operation, args, kind in (
            (uncons_unit, ([],), "Stack-Error"),
            (uncons_unit, (1,), "Type-Error"),
            (cons_unit, (1, [2]), "Type-Error"),
            (cons_unit, ([], []), "Type-Error"),
            (cons_unit, ([], [1, 2]), "Type-Error"),
        ):
            with self.subTest(args=args), self.assertRaises(BoError) as error:
                operation(*args)
            self.assertEqual(error.exception.kind, kind)


if __name__ == "__main__":
    unittest.main()
