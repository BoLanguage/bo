import contextlib
import io
import os
import tempfile
import unittest

from python.bo.lower import lower_word_forms
from python.bo.machine import AbortSignal, Machine, WORD_DIAGNOSTICS_KEY
from python.bo.values import Word, from_str


def run(code, standard_library=False):
    machine = Machine()
    with contextlib.redirect_stderr(io.StringIO()):
        if standard_library:
            if not (machine.include_file("include/core.bo") and machine.include_file("include/std.bo")):
                raise RuntimeError("cannot load standard library")
        elif not (machine.include_file("include/core.bo") and machine.include_file("include/std.bo")):
            raise RuntimeError("cannot load default library")
        program = [item for _, items in lower_word_forms(code) for item in items]
        machine.run(program)
    return machine.data


class WordExecution(unittest.TestCase):
    def test_execution_and_redefinition(self):
        self.assertEqual(run("(1) (X) PUSH X (2) (X) PUSH X (X) POP X"),
                         [1, 2, [2], 1])

    def test_unit_round_trips_without_executing_words(self):
        self.assertEqual(run("(OP 2 3) unconsl"), [[2, 3], [Word("OP")]])
        self.assertEqual(run("(1 2 OP) unconsr"), [[1, 2], [Word("OP")]])
        self.assertEqual(run("(OP 2 3) unconsl consl"), [[Word("OP"), 2, 3]])
        self.assertEqual(run("(1 2 OP) unconsr consr"), [[1, 2, Word("OP")]])

    def test_conversions_and_unit_types(self):
        self.assertEqual(run('"OP" word text'), [from_str("OP")])
        self.assertEqual(run("(OP) text word"), [[Word("OP")]])
        self.assertEqual(run("(42) unittype ((1 2)) unittype (OP) unittype"), [0, 1, 2])
        self.assertEqual(run('"+" word'), [[Word("+")]])
        self.assertEqual(run('1 2 "+" word apply'), [3])
        self.assertEqual(run('(17) (OP) PUSH "OP" word apply'), [17])
        self.assertEqual(run('(1) unconsl apply ((1 2)) unconsl apply'), [[], 1, [], [1, 2]])

    def test_matlab_style_range_operators(self):
        self.assertEqual(
            run("1 10 : 0 2 10 :: 0 0.1 0.3 :: 0 0.3 :"),
            [list(range(1, 11)), [0, 2, 4, 6, 8, 10],
             [0, 0.1, 0.2, 0.3], [0]],
        )
        self.assertEqual(run("3 -1 0 :: 0 0 3 :: 3 1 0 ::"),
                         [[3, 2, 1, 0], [], []])
        self.assertEqual(run("1 (COLON-STACK) PUSH 1 (COLON-STACK) PUSH "
                             "10 (COLON-STACK) PUSH (COLON-STACK) RANGE "
                             "(COLON-STACK) POP"),
                         [list(range(1, 11))])

    def test_range_errors_restore_operands(self):
        data = run('("x" 0.1 1 ::) () catch')
        self.assertEqual(data[:3], [from_str("x"), 0.1, 1])
        self.assertEqual(data[-1][0:2], [[Word("Type-Error")], [Word("RANGE")]])
        for code in ("(0 1e-320 1 ::) () catch",
                     "(0 1 4294967295 ::) () catch"):
            data = run(code)
            self.assertEqual(data[-1][0:2],
                             [[Word("Resource-Error")], [Word("RANGE")]])

    def test_parse_reads_source_text_into_a_program_without_running_it(self):
        self.assertEqual(run('"1 2 +" parse'), [[1, 2, Word("+")]])
        self.assertEqual(run('"" parse'), [[]])
        self.assertEqual(run(r'"(1 (A) \"x\") ; note\n5" parse'),
                         [[[1, [Word("A")], from_str("x")], 5]])
        self.assertEqual(run('"2 3 *" eval', standard_library=True), [6])

    def test_parse_reports_source_errors_as_catchable_syntax_errors(self):
        for code, message, line in (('"(1 2"', "unmatched '('", 1),
                                    (r'"1\n2\n)"', "unmatched ')'", 3),
                                    (r'"\"a\\q\""', "bad escape \\q", 1)):
            with self.subTest(code=code):
                data = run(f"({code} parse) () catch")
                self.assertEqual(data[-1][:3], [[Word("Syntax-Error")], [Word("PARSE")],
                                                [from_str(message), line]])
                self.assertEqual(len(data), 2)
        data = run('("1 (" eval) () catch', standard_library=True)
        self.assertEqual([data[0], data[1][0]], [from_str("1 ("), [Word("Syntax-Error")]])

    def test_parse_rejects_what_is_not_source_text(self):
        for code, kind in (("(A)", "Type-Error"), ("5", "Type-Error"),
                           ("(1114112)", "Domain-Error")):
            with self.subTest(code=code):
                data = run(f"({code} parse) () catch")
                self.assertEqual(data[-1][:2], [[Word(kind)], [Word("PARSE")]])

    def test_tensor_construction_inspection_reshape_get_and_set(self):
        reshaped = [[1, 2, 3, 4, 5, 6], [3, 2]]
        self.assertEqual(
            run("(1 2 3 4 5 6) (2 3) array dup shape swap rank "
                "(1 2 3 4 5 6) (2 3) array (3 2) reshape "
                "dup (2 1) -> swap "
                "dup unit unittype", standard_library=True),
            [[2, 3], 2, 6, reshaped, 1],
        )
        self.assertEqual(run("(1) () array shape (1) () array rank "
                             "(1) () array () ->"),
                         [[], 0, 1])
        self.assertEqual(
            run("(1 2 3 4 5 6) (2 3) array "
                "(1 2 3 4 5 6) (2 3) array (1 2) 99 <-"),
            [[[1, 2, 3, 4, 5, 6], [2, 3]], [[1, 2, 3, 4, 5, 99], [2, 3]]],
        )
        self.assertEqual(run("() (0 3) array dup shape swap rank", standard_library=True),
                         [[0, 3], 2])
        self.assertEqual(
            run("(1 2 3 4 5) (5) array 3 chunk concat "
                "(1 2 3 4 5) (5) array 8 chunk "
                "(1 2 3 4) (4) array 2 chunk (2 (*) .) () PARALLEL concat"),
            [[[1, 2, 3, 4, 5], [5]],
             [[[1], [1]], [[2], [1]], [[3], [1]], [[4], [1]], [[5], [1]],
              [[], [0]], [[], [0]], [[], [0]]],
             [[2, 4, 6, 8], [4]]],
        )
        self.assertEqual(run("() concat"), [[[], [0]]])
        self.assertEqual(
            run("(1 2 3 4 5 6) (2 3) array () (+) .. "
                "(7) () array () (+) .."),
            [21, 7],
        )
        self.assertEqual(
            run("(1 2 3 4 5 6) (2 3) array 0 (+) .. "
                "(1 2 3 4 5 6) (2 3) array 1 (+) .. "
                "(1 2 3 4 5 6 7 8) (2 2 2) array 1 (+) .. "
                "(1 2 3) (3) array 0 (+) .. "
                "() (0 3) array 1 (+) .."),
            [[[5, 7, 9], [3]], [[6, 15], [2]], [[4, 6, 12, 14], [2, 2]],
             [[6], []], [[], [0]]],
        )
        self.assertEqual(
            run("(-2 0 3 4) (2 2) array () (*) .. "
                "(-2 0 3 4) (2 2) array () any "
                "(-2 0 3 4) (2 2) array () all "
                "(-2 0 3 4) (2 2) array () (min) .. "
                "(-2 0 3 4) (2 2) array () (max) .. "
                "(1 2 3 4 5 6) (2 3) array 0 (*) .. "
                "(1 2 3 4 5 6) (2 3) array 0 any "
                "(1 2 3 4 5 6) (2 3) array 0 all "
                "(1 2 3 4 5 6) (2 3) array 0 (min) .. "
                "(1 2 3 4 5 6) (2 3) array 0 (max) .. "
                "() (0 0) array 0 (min) .."),
            [0, 1, 0, -2, 4,
             [[4, 10, 18], [3]], [[1, 1, 1], [3]], [[1, 1, 1], [3]],
             [[1, 2, 3], [3]], [[4, 5, 6], [3]], [[], [0]]],
        )
        self.assertEqual(
            run("(1 2 3) (3) array (4 5 6) (3) array dot "
                "() (0) array () (0) array dot"),
            [32, 0],
        )
        self.assertEqual(
            run("(1 2 3 4) (4) array flip () (0) array flip "
                "(1 2 3 4 5 6) (2 3) array flipud "
                "(1 2 3 4 5 6) (2 3) array fliplr "
                "() (0 3) array flipud () (3 0) array fliplr"),
            [[[4, 3, 2, 1], [4]], [[], [0]],
             [[4, 5, 6, 1, 2, 3], [2, 3]], [[3, 2, 1, 6, 5, 4], [2, 3]],
             [[], [0, 3]], [[], [3, 0]]],
        )
        for code in ('(((1 2 3 4) (2 2)) flip) () catch',
                     '(((1 2) (2)) fliplr) () catch',
                     '(((1 2) (2)) flipud) () catch'):
            with self.subTest(code=code):
                self.assertEqual(run(code)[-1][0:2],
                                 [[Word("Shape-Error")], [Word("THROW")]])
        self.assertEqual(
            run("(1 2 3 4 5 6) (2 3) array () mean "
                "(1 2 3 4 5 6) (2 3) array 0 mean "
                "(1 9 2 8 3 7) (2 3) array () median "
                "(1 9 2 8 3 7) (2 3) array 0 median "
                "(3 1 2) (3) array () median "
                "(-1e308 1e308) (2) array () median "
                "(1 2 3 4 5 6) (2 3) array transpose "
                "(1 2) (2) array (3 4 5) (3) array outer "
                "(1 2 3 4 5 6) (2 3) array "
                "(7 8 9 10 11 12) (3 2) array matmul"),
            [3.5, [[2.5, 3.5, 4.5], [3]], 5, [[4.5, 6, 4.5], [3]], 2, 0,
             [[1, 4, 2, 5, 3, 6], [3, 2]],
             [[3, 4, 5, 6, 8, 10], [2, 3]], [[58, 64, 139, 154], [2, 2]]],
        )
        self.assertEqual(
            run("(1 2 3) (4 5) zip "
                "(1 2 3 4) (4) array (5 6 7 8) (4) array "
                "2dup 2 chunk swap 2 chunk swap zip "
                "(unconsl apply swap unconsl apply swap drop dot) parallel "
                "(apply apply unit) map 0 (apply +) foldl -rot dot =",
                standard_library=True),
            [[[1, 4], [2, 5]], 1],
        )
        self.assertEqual(run("(1 2) (2) array (TENSOR-WORK) PUSH "
                             "(TENSOR-WORK) SHAPE (TENSOR-WORK) POP"),
                         [[2]])
        self.assertEqual(run("((1 2 3 4 5 6) (2 3)) "
                             "((1 2 3 4 5 6) (2 3)) ="),
                         [1])
        self.assertEqual(run("((1 2) (2)) type"), [1])

    def test_tensor_invalid_operands_restore_and_report_errors(self):
        cases = (
            ('((1 A) (2) array) () catch', "Type-Error", "ARRAY"),
            ('((1 2) (3) array) () catch', "Shape-Error", "ARRAY"),
            ('((1 2) (-1 2) array) () catch', "Domain-Error", "ARRAY"),
            ('(((1 A) (2)) shape) () catch', "Type-Error", "SHAPE"),
            ('(((1 2) (3)) rank) () catch', "Shape-Error", "RANK"),
            ('(((1 2) (-1 2)) shape) () catch', "Domain-Error", "SHAPE"),
            ('(((1 2) (2)) (3) reshape) () catch', "Shape-Error", "RESHAPE"),
            ('(((1 2) (2)) (2) ->) () catch', "Domain-Error", "FETCH"),
            ('(((1 2) (2)) (A) ->) () catch', "Type-Error", "FETCH"),
            ('(((1 2) (2)) (1) (A) <-) () catch', "Type-Error", "STORE"),
            ('(((1 2) (2)) 0 chunk) () catch', "Domain-Error", "CHUNK"),
            ('(((1 2) (2)) 1.5 chunk) () catch', "Type-Error", "CHUNK"),
            ('(((1 2) (1 2)) 2 chunk) () catch', "Shape-Error", "CHUNK"),
            ('((42) concat) () catch', "Type-Error", "CONCAT"),
            ('((((1 2) (1 2))) concat) () catch', "Shape-Error", "CONCAT"),
            ('(((1 A) (2)) () (+) ..) () catch', "Type-Error", "REDUCE"),
            ('(((1e308 1e308) (2)) () (+) ..) () catch', "Evaluation-Error", "ADD"),
            ('(((1 2) (2)) 1.5 (+) ..) () catch', "Type-Error", "REDUCE"),
            ('(((1 2) (2)) (0) (+) ..) () catch', "Type-Error", "REDUCE"),
            ('(((1 2) (2)) -1 (+) ..) () catch', "Domain-Error", "REDUCE"),
            ('(((1) ()) 0 (+) ..) () catch', "Domain-Error", "REDUCE"),
            ('(((1 2) (2)) () 5 ..) () catch', "Type-Error", "REDUCE"),
            ('(((1 2) (2)) () (+ -) ..) () catch', "Type-Error", "REDUCE"),
            ('(() (0 65536 65536) array 0 (+) ..) () catch',
             "Resource-Error", "REDUCE"),
            ('(((1e308 1e308) (2)) 0 (+) ..) () catch', "Evaluation-Error", "ADD"),
            ('(((1e308 1e308) (2)) () (*) ..) () catch', "Evaluation-Error", "MUL"),
            ('((() (0)) () (+) ..) () catch', "Domain-Error", "REDUCE"),
            ('((() (0 3)) 0 (+) ..) () catch', "Domain-Error", "REDUCE"),
            ('((() (0)) () (min) ..) () catch', "Domain-Error", "REDUCE"),
            ('((() (0)) () (max) ..) () catch', "Domain-Error", "REDUCE"),
            ('((() (0 1)) 0 (min) ..) () catch', "Domain-Error", "REDUCE"),
            ('((() (0)) () any) () catch', "Domain-Error", "REDUCE"),
            ('((() (0)) () all) () catch', "Domain-Error", "REDUCE"),
            ('(((1 2) (2)) () (UNDEFINED-WORD) ..) () catch', "Existence-Error", "WORD"),
            ('((() (0 3)) () mean) () catch', "Domain-Error", "MEAN"),
            ('(() (0 65536 65536) array 0 mean) () catch',
             "Resource-Error", "MEAN"),
            ('((() (0 3)) () median) () catch', "Domain-Error", "MEDIAN"),
            ('((() (2 0)) 1 median) () catch', "Domain-Error", "MEDIAN"),
            ('(((1 2) (2)) (0) median) () catch', "Type-Error", "MEDIAN"),
            ('(((1 2) (2)) transpose) () catch', "Shape-Error", "TRANSPOSE"),
            ('(((1 2) (2)) ((3 4) (2)) matmul) () catch',
             "Shape-Error", "MATMUL"),
            ('(((1 2) (1 2)) ((3 4) (1 2)) matmul) () catch',
             "Shape-Error", "MATMUL"),
            ('(((1 2) (2)) ((3 4 5) (3)) dot) () catch', "Shape-Error", "DOT"),
            ('(((1 2 3 4) (2 2)) ((1 2 3 4) (4)) dot) () catch',
             "Shape-Error", "DOT"),
            ('(((1e308) (1)) ((1e308) (1)) dot) () catch',
             "Evaluation-Error", "DOT"),
        )
        for code, kind, where in cases:
            with self.subTest(code=code):
                data = run(code)
                self.assertEqual(data[-1][0:2], [[Word(kind)], [Word(where)]])
                if where in ("ADD", "MUL"):
                    self.assertEqual(data[-1][2], [1e308, 1e308])
                elif where != "WORD":
                    self.assertEqual(data[-1][2], data[:-1])

    def test_tensor_broadcast_operators(self):
        self.assertEqual(
            run("(1 2 3 4 5 6) (2 3) array (10 20 30) (1 3) array (+) . "
                "(1 2) (2 1) array (10 20 30) (3) array (+) . "
                "(1 2 3 4 5 6) (2 3) array 2 (*) . "
                "(1 2 3 4 5 6) (2 3) array 2 (/) . "
                "(1 2 3) (3) array 2 (^) ."),
            [[[11, 22, 33, 14, 25, 36], [2, 3]],
             [[11, 21, 31, 12, 22, 32], [2, 3]],
             [[2, 4, 6, 8, 10, 12], [2, 3]],
             [[0.5, 1, 1.5, 2, 2.5, 3], [2, 3]],
             [[1, 4, 9], [3]]],
        )
        self.assertEqual(run("() (0 3) array 2 (*) . (2) () array 1 (+) ."),
                         [[[], [0, 3]], [[3], []]])
        self.assertEqual(run("(1 2) (2) array (BROADCAST-WORK) PUSH "
                             "3 (BROADCAST-WORK) PUSH (+) (BROADCAST-WORK) PUSH "
                             "(BROADCAST-WORK) BROADCAST (BROADCAST-WORK) POP"),
                         [[[4, 5], [2]]])
        self.assertEqual(run("2 3 (+) . 7 2 (-) . 3 4 (*) . 8 2 (/) ."), [5, 5, 12, 4])

    def test_broadcast_errors_restore_operands(self):
        cases = (
            ('((1 2) (2) array (1 2 3) (3) array (+) .) () catch',
             "Shape-Error", "BROADCAST", None),
            ('((1 2) (2) (+) .) () catch', "Type-Error", "BROADCAST", None),
            ('((1 2) (2) array 1 (+ -)  .) () catch', "Type-Error", "BROADCAST", None),
            ('((1 1) (2) array (1 0) (2) array (/) .) () catch',
             "Domain-Error", "DIV", [1, 0]),
            ('((-1) (1) array 0.5 (^) .) () catch', "Domain-Error", "POW", [-1, 0.5]),
            ('((1 2) (2) array 1 (UNDEFINED-WORD) .) () catch',
             "Existence-Error", "WORD", [[Word("UNDEFINED-WORD")]]),
            ('((1 2) (2) array 1 (dup) .) () catch', "Stack-Error", "BROADCAST", [1, 1]),
            ('(drop drop) (nothing) PUSH ((1 2) (2) array 1 (nothing) .) () catch',
             "Stack-Error", "BROADCAST", [1, 1]),
            ('(drop drop ()) (listy) PUSH ((1 2) (2) array 1 (listy) .) () catch',
             "Type-Error", "BROADCAST", [1, 1]),
        )
        for code, kind, where, details in cases:
            with self.subTest(code=code):
                data = run(code)
                self.assertEqual(data[-1][0:2], [[Word(kind)], [Word(where)]])
                if details is not None:
                    self.assertEqual(data[-1][2], details)
                self.assertEqual(len(data), 4)
                if details is None:
                    self.assertEqual(data[-1][2], data[:-1])

    def test_broadcast_runs_any_word_on_each_pair(self):
        self.assertEqual(
            run("(+ dup *) (sumsq) PUSH (1 2 3) (3) array (4 5 6) (3) array (+) . "
                "(1 2 3) (3) array 5 (max) . (3 1 2) (3) array 2 (//) . "
                "(1 2 3) (3) array 10 (drop) . 2 3 (sumsq) . 7 9 (rem) ."),
            [[[5, 7, 9], [3]], [[5, 5, 5], [3]], [[1, 0, 1], [3]], [[1, 2, 3], [3]], 25, 7],
        )
        self.assertEqual(run("(swap drop 10 swap -) (rsub) PUSH 4 (1 2 3) (3) array (rsub) ."),
                         [[[9, 8, 7], [3]]])

    def test_broadcast_uses_the_current_definition_of_the_word(self):
        self.assertEqual(
            run("(1 2 3) (3) array 10 (+) . (drop drop 7) (+) PUSH "
                "(1 2 3) (3) array 10 (+) . (+) POP drop "
                "(1 2 3) (3) array 10 (+) ."),
            [[[11, 12, 13], [3]], [[7, 7, 7], [3]], [[11, 12, 13], [3]]],
        )

    def test_broadcast_restores_the_stack_when_the_word_misbehaves(self):
        data = run("(drop drop drop 0) (eat) PUSH "
                   "100 200 ((1 2) (2) array 1 (eat) .) () catch")
        self.assertEqual(data[:5], [100, 200, [[1, 2], [2]], 1, [Word("eat")]])
        self.assertEqual(data[5][0:2], [[Word("Stack-Error")], [Word("BROADCAST")]])

    def test_invalid_operands_are_catchable_and_restored(self):
        data = run('("a b" word) () catch')
        self.assertEqual(data[0], from_str("a b"))
        self.assertEqual(data[1][0], [Word("Representation-Error")])
        data = run('(() () consl) () catch')
        self.assertEqual(data[:2], [[], []])
        self.assertEqual(data[2][0], [Word("Type-Error")])

    def test_undefined_word_does_not_push_its_name(self):
        with self.assertRaises(AbortSignal):
            run("NOT-DEFINED")
        data = run("(NOT-DEFINED) () catch")
        self.assertEqual(data[0][0], [Word("Existence-Error")])
        self.assertEqual(data[0][1], [Word("WORD")])
        self.assertEqual(data[0][2], [[Word("NOT-DEFINED")]])

    def test_primitive_stack_protection_and_redefinition(self):
        data = run("((1) (DROP) PUSH) () catch")
        self.assertEqual(data[-1][0], [Word("Permission-Error")])
        self.assertEqual(run('(DROP) UNLOCK (99) (DROP) PUSH 42 drop (DROP) POP drop'),
                         [42, [], 99])

    def test_drop_redefinition_in_active_frame(self):
        self.assertEqual(
            run('((DROP) UNLOCK (99) (DROP) PUSH "x" drop 7) (TEST) PUSH TEST'),
            [[120], [], 99, 7],
        )

    def test_unit_callbacks_for_map_and_fold(self):
        self.assertEqual(
            run("(OP 2 3) () map (1 2 3) (apply 1 + unit) map "
                "(1 2 3) 0 (apply +) foldl "
                "(1 2 3) 0 (swap apply swap -) foldr "
                "(OP A) () (swap consl) foldr "
                "(1 OP 3) 2 nth (OP) (1 OP 2) in",
                standard_library=True),
            [[Word("OP"), 2, 3], [2, 3, 4], 6, 2,
             [Word("OP"), Word("A")], [Word("OP")], 1],
        )

    def test_standard_library_list_operations_preserve_word_elements(self):
        a, b, c, d = (Word(name) for name in "ABCD")
        self.assertEqual(
            run("(A (B C) 3) (D) append "
                "(A (B C) 3) 2 split (A (B C) 3) 2 sel "
                "(A 3) (B) 2 ins (A (B C) 3) len "
                "(A (B C) 3) ((COLLECT) PUSH) foreach (COLLECT) SNAPSHOT",
                standard_library=True),
            [[a, [b, c], 3, d], [a, [b, c]], [3], [a, 3], [[b, c]],
             [a, b, 3], 3, [[a], [[b, c]], [3]]],
        )

    def test_map_rejects_non_unit_callback_results(self):
        data = run("((1) (apply 1 +) map) () catch", standard_library=True)
        self.assertEqual(data[-1][0], [Word("Type-Error")])

    def test_mask_keeps_the_elements_where_the_mask_is_true(self):
        op = Word("OP")
        self.assertEqual(run("(1 2 3 4 5) (0 0 1 1 0) mask", standard_library=True), [[3, 4]])
        self.assertEqual(run("(1 2 3 4 5) (1 1) mask", standard_library=True), [[1, 2]],
                         "it stops at the shorter list")
        self.assertEqual(run("() () mask (1 2 3) (0 0 0) mask (1 2 3) (1 1 1) mask", standard_library=True),
                         [[], [], [1, 2, 3]])
        self.assertEqual(run("((1 2) OP 3 (4)) (1 0 2 1) mask ((1 2) OP) (0 1) mask", standard_library=True),
                         [[[1, 2], 3, [4]], [op]], "positive means true; words and lists are kept as they are")

    def test_filter_keeps_the_elements_for_which_the_predicate_is_true(self):
        self.assertEqual(run("(1 2 3 4 5 6) (apply 2 mod 0 =) filter", standard_library=True), [[2, 4, 6]])
        self.assertEqual(run("() (drop 1) filter (1 2) (drop 0) filter (1 2) (drop 1) filter",
                             standard_library=True), [[], [], [1, 2]])
        self.assertEqual(run("((1) (2 3) (4)) (apply len 1 =) filter", standard_library=True), [[[1], [4]]],
                         "the predicate gets each element as a unit, as map does")

    def test_startswith_endswith_and_contains_compare_runs_of_elements(self):
        self.assertEqual(
            run('"puzzle.x" "puzzle." startswith "foo" "puzzle." startswith "puz" "puzzle." startswith '
                '"" "" startswith ((1) 2 (3)) ((1) 2) startswith', standard_library=True),
            [1, 0, 0, 1, 1])
        self.assertEqual(
            run('"x.bo" ".bo" endswith "bo" ".bo" endswith (1 2 3) () endswith ((1) 2 (3)) (2 (3)) endswith',
                standard_library=True),
            [1, 0, 1, 1])
        self.assertEqual(
            run('"hello world" "o w" contains "hello world" "xyz" contains "abc" "" contains "" "a" contains '
                '(1 (2 3) 4) ((2 3) 4) contains (1 2 3) (3 2) contains', standard_library=True),
            [1, 0, 1, 0, 1, 0])

    def test_standard_library_control_and_unfold(self):
        self.assertEqual(
            run("5 unit (A B) unit 0 (dup 5 <) (1 +) loop "
                "5 ((dup 0 =) (drop 1) (dup 1 - rec *) ifte) lambda "
                "() 0 (dup 3 =) (1 +) unfoldl "
                "() 0 (dup 3 =) (1 +) unfoldr", standard_library=True),
            [[5], [[Word("A"), Word("B")]], 5, 120, [3, 2, 1], [1, 2, 3]],
        )
        self.assertEqual(run("2 1.5 ^", standard_library=True), [2**1.5])
        data = run("(-2 0.5 ^) () catch", standard_library=True)
        self.assertEqual(data[-1][0], [Word("Domain-Error")])
        for code in ("(5 () in) () catch", "((1 2) () in) () catch"):
            self.assertEqual(run(code, standard_library=True)[-1][0], [Word("Type-Error")])

    def test_standard_library_output_never_executes_list_elements(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            data = run('(99) (OP) PUSH "hi!" emits '
                       '(OP (1 +) "OP" word text) emit nl '
                       '(OP (1 +) "OP") ps', standard_library=True)
        self.assertEqual(out.getvalue(), "hi!(OP (1 +) (79 80) word text)\n"
                                        "  0: (OP (1 +) (79 80))\n")
        self.assertEqual(data, [[Word("OP"), [1, Word("+")], from_str("OP")]])

    def test_emit_writes_numbers_and_emitc_a_character(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            run("65 emit 32 emitc 65 emitc nl -7 emit 32 emitc 3.5 emit nl", standard_library=True)
        self.assertEqual(out.getvalue(), "65 A\n-7 3.5\n")

    def test_emit_refuses_an_integer_that_is_no_longer_exact(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            data = run("9007199254740992 emit nl (9007199254740994 emit) () catch "
                       "(1 -9007199254740994 emit) () catch", standard_library=True)
        self.assertEqual(out.getvalue(), "9007199254740992\n")
        self.assertEqual([value[0] for value in data if isinstance(value, list) and value
                          and isinstance(value[0], list) and value[0] == [Word("Domain-Error")]],
                         [[Word("Domain-Error")]] * 2)

    def test_text_rejects_word_elements_without_executing_them(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            data = run('(99) (SIDE) PUSH ((SIDE) emits) () catch '
                       '((SIDE) 1 puts) () catch', standard_library=True)
        self.assertEqual(out.getvalue(), "")
        errors = [value for value in data if isinstance(value, list) and value
                  and value[0] == [Word("Type-Error")]]
        self.assertEqual(len(errors), 2)
        self.assertNotIn(99, data)

    def test_standard_library_file_io(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "text")
            code = (f'(72 105 33) "{path}" "w" open dup -rot puts close '
                    f'3 "{path}" "r" open dup -rot gets swap close')
            self.assertEqual(run(code, standard_library=True), [[72, 105, 33]])

    def test_standard_library_stack_display_alignment_and_elision(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            data = run(" ".join(map(str, range(20))) + " ps", standard_library=True)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 11)
        self.assertEqual(lines[:2], ["  19: 0", "  18: 1"])
        self.assertEqual(lines[5:7], ["  ...", "   4: 15"])
        self.assertEqual(lines[-1], "   0: 19")
        self.assertEqual(data, list(range(20)))

    def test_standard_library_displays_structural_tensors_as_lists(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            data = run("((1 2) (2)) emit ((1 2) (2)) ps", standard_library=True)
        self.assertEqual(output.getvalue(), "((1 2) (2))  0: ((1 2) (2))\n")
        self.assertEqual(data, [[[1, 2], [2]]])

    def test_standard_library_display_round_trips_distinct_value_kinds(self):
        source = '(OP "OP" (OP) (+ word text π) (1 (2 3) ()) ((1 2) (2)) -5 2.5)'
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            run(source + " emit", standard_library=True)
        rendered = output.getvalue()
        self.assertEqual(rendered, "(OP (79 80) (OP) (+ word text π) (1 (2 3) ()) ((1 2) (2)) -5 2.5)")
        original = lower_word_forms(source)[0][1]
        self.assertEqual(lower_word_forms(rendered)[0][1], original)


class WordSourceExecution(unittest.TestCase):
    def setUp(self):
        self.machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(self.machine.include_file("include/core.bo"))
            self.assertTrue(self.machine.include_file("include/std.bo"))

    def execute(self, code, source="test", first_line=1):
        with contextlib.redirect_stderr(io.StringIO()):
            return self.machine.execute(code, source, first_line)

    def test_source_and_global_exception_handler(self):
        self.assertTrue(self.execute("() (EXCEPTION) PUSH\nMISSING", "sample.bo", 7))
        self.assertEqual(
            self.machine.data,
            [[[Word("Existence-Error")], [Word("WORD")], [[Word("MISSING")]],
              from_str("sample.bo"), 8]],
        )
        self.machine.data.clear()
        self.assertTrue(self.execute("(drop 99) (EXCEPTION) PUSH 1 0 / 100"))
        self.assertEqual(self.machine.data, [1, 0, 99, 100])
        self.machine.data.clear()
        self.assertFalse(self.execute("(drop abort) (EXCEPTION) PUSH MISSING 100"))
        self.assertEqual(self.machine.data, [])

    def test_include_uses_word_lowering_and_tracks_nested_source(self):
        with tempfile.TemporaryDirectory() as directory:
            outer = os.path.join(directory, "outer.bo")
            inner = os.path.join(directory, "inner.bo")
            with open(inner, "w", encoding="utf-8") as file:
                file.write("(1 +) (SUCC) PUSH\n\nMISSING\n")
            with open(outer, "w", encoding="utf-8") as file:
                file.write(f'"{inner}" include\n2 SUCC\n')
            self.assertTrue(self.execute(f'() (EXCEPTION) PUSH "{outer}" include'))
            error, value = self.machine.data
            self.assertEqual(error, [[Word("Existence-Error")], [Word("WORD")],
                                     [[Word("MISSING")]], from_str(inner), 3])
            self.assertEqual(value, 3)
            self.machine.data.clear()
            self.assertTrue(self.execute(f'"{outer}" included "{inner}" included'))
            self.assertEqual(self.machine.data, [1, 1])

    def test_handlers_respect_nearest_catch_and_failure_in_handler(self):
        self.assertTrue(self.execute("(drop 99) (EXCEPTION) PUSH "
                                     "(MISSING) (drop 42) catch 100"))
        self.assertEqual(self.machine.data, [42, 100])
        self.machine.data.clear()
        self.assertTrue(self.execute("(MISSING) (OTHER-MISSING) catch"))
        self.assertEqual(self.machine.data[-1], 99)
        self.machine.data.clear()
        self.assertFalse(self.execute("(OTHER-MISSING) (EXCEPTION) PUSH MISSING"))
        self.assertEqual(self.machine.data[0][0], [Word("Existence-Error")])
        self.assertEqual(self.machine.data[0][2], [[Word("MISSING")]])

    def test_examples_range_with_word_values(self):
        self.assertTrue(self.execute('"examples/lib.bo" require '
                                     '1 4 range 3 3 range 5 2 range -2 1 range'))
        self.assertEqual(self.machine.data, [[1, 2, 3], [], [], [-2, -1, 0]])

    def test_include_parse_failure_is_catchable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "bad.bo")
            with open(path, "w", encoding="utf-8") as file:
                file.write("\n(1\n")
            self.assertTrue(self.execute(f'("{path}" include) () catch'))
            self.assertEqual(self.machine.data[-1][0], [Word("Syntax-Error")])
            self.assertEqual(self.machine.data[-1][1], [Word("INCLUDE")])
            self.assertEqual(self.machine.data[-1][2][-1], 2)

    def test_catch_around_include_catches_runtime_errors_of_the_file(self):
        self.assertTrue(self.execute('("tests/include_failure.bo" () INCLUDE) () catch '
                                     '(INCLUDE-BEFORE) DEPTH (INCLUDE-AFTER) DEPTH'))
        data = self.machine.data
        error = data[2]
        self.assertEqual(error[:3], [[Word("Domain-Error")], [Word("DIV")], [1, 0]])
        self.assertEqual(error[3:], [from_str("tests/include_failure.bo"), 2])
        self.assertEqual(data[:2] + data[3:], [1, 0, 1, 0])
        self.assertEqual(self.machine.stacks[WORD_DIAGNOSTICS_KEY], [error])

    def test_catch_around_nested_includes_and_rethrow_keep_the_original_error(self):
        self.assertTrue(self.execute(
            '(("tests/include_nested.bo" () INCLUDE) (rethrow) catch) (drop 5) catch '
            '(NESTED-AFTER) DEPTH', "outer.bo", 7))
        data = self.machine.data
        self.assertEqual(data[-2:], [5, 0])
        diagnostics = self.machine.stacks[WORD_DIAGNOSTICS_KEY]
        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(diagnostics[0][3:], [from_str("tests/include_failure.bo"), 2])

    def test_include_runtime_errors_without_a_catch_reach_the_exception_handler_and_resume(self):
        self.assertTrue(self.execute('(drop 1 (HANDLED) PUSH) (EXCEPTION) PUSH '
                                     '"tests/include_failure.bo" () INCLUDE '
                                     '(HANDLED) DEPTH (INCLUDE-AFTER) DEPTH'))
        self.assertEqual(self.machine.data[-2:], [1, 1])

    def test_include_handles_an_error_with_a_catch_inside_the_file_first(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "inner.bo")
            with open(path, "w", encoding="utf-8") as file:
                file.write("(1 0 /) (drop 4 (INNER) PUSH) catch\n")
            self.assertTrue(self.execute(f'("{path}" () INCLUDE) (drop 9) catch (INNER) DEPTH'))
        self.assertEqual(self.machine.data, [1, 0, 1])

    def test_require_loads_a_file_once_and_include_reloads_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "once.bo")
            with open(path, "w", encoding="utf-8") as file:
                file.write("1 (LOADED) PUSH 7\n")
            self.assertTrue(self.execute(
                f'"{path}" require "{path}" require (LOADED) DEPTH "{path}" included'))
            self.assertEqual(self.machine.data, [7, 1, 1])
            self.machine.data.clear()
            self.assertTrue(self.execute(f'"{path}" include (LOADED) DEPTH'))
            self.assertEqual(self.machine.data, [7, 1])
            self.machine.data.clear()
            self.assertTrue(self.execute(f'"{path}" () INCLUDE (LOADED) DEPTH'))
            self.assertEqual(self.machine.data, [7, 1])

    def test_reloading_the_standard_library_does_not_hit_locked_stacks(self):
        self.assertTrue(self.execute(
            '"include/std.bo" () INCLUDE "include/std.bo" require "include/stream.bo" require '
            '"include/io.bo" require 1 2 +'))
        self.assertEqual(self.machine.data, [3])
        # include reloads: stream.bo resets and relocks its stacks, so nothing accumulates
        self.machine.data.clear()
        self.assertTrue(self.execute(
            '"include/stream.bo" include "include/std.bo" include '
            '(stdin) DEPTH (stdout) DEPTH (stderr) DEPTH stdout (stdout) LOCKED'))
        self.assertEqual(self.machine.data, [1, 1, 1, 1, 1])
        self.assertFalse(self.execute("2 (stdout) PUSH"))

    def test_require_cycles_terminate(self):
        with tempfile.TemporaryDirectory() as directory:
            first = os.path.join(directory, "first.bo")
            second = os.path.join(directory, "second.bo")
            with open(first, "w", encoding="utf-8") as file:
                file.write(f'1 (CYCLE) PUSH "{second}" require\n')
            with open(second, "w", encoding="utf-8") as file:
                file.write(f'2 (CYCLE) PUSH "{first}" require\n')
            self.assertTrue(self.execute(f'"{first}" require (CYCLE) DEPTH'))
            self.assertEqual(self.machine.data, [2])

    def test_syntax_error_runs_handler_and_restores_source(self):
        self.assertTrue(self.execute("(drop 99) (EXCEPTION) PUSH"))
        self.assertFalse(self.execute("1 )", "bad.bo", 7))
        self.assertEqual(self.machine.data, [99])
        self.assertEqual((self.machine.source, self.machine.line), ("stdin", 1))
        self.assertEqual(self.machine.control, [])
        self.assertTrue(self.execute("5", "next.bo"))
        self.assertEqual(self.machine.data, [99, 5])


if __name__ == "__main__":
    unittest.main()
