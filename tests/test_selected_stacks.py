import contextlib
import io
import subprocess
import sys
import unittest
from pathlib import Path

from python.bo.machine import Machine
from python.bo.values import Word, canon, from_str


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import generate_adapters  # noqa: E402

WRAPPERS = {
    "snapshot": "SNAPSHOT", "depth": "DEPTH", "clear": "CLEAR", "lock": "LOCK",
    "unlock": "UNLOCK", "drop": "DROP", "pick": "PICK", "roll": "ROLL",
    "unit": "UNIT", "consl": "CONSL", "consr": "CONSR", "unconsl": "UNCONSL", "unconsr": "UNCONSR",
    "type": "TYPE", "ratio": "RATIO", "apply": "APPLY", "ifte": "IFTE", "loop": "LOOP",
    "parallel": "PARALLEL",
    "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "//": "IDIV",
    "::": "RANGE",
    ".": "BROADCAST", "..": "REDUCE", "->": "FETCH", "<-": "STORE",
    "^": "POW", "=": "EQUAL", "open": "OPEN", "close": "CLOSE",
    "read": "READ", "write": "WRITE", "catch": "CATCH", "throw": "THROW",
    "call": "CALL", "rethrow": "RETHROW",
    "exit": "EXIT", "abort": "ABORT", "unittype": "UNITTYPE", "word": "WORD",
    "text": "TEXT", "include": "INCLUDE", "included": "INCLUDED", "parse": "PARSE", "lexicon": "LEXICON",
    "array": "ARRAY", "shape": "SHAPE", "rank": "RANK", "reshape": "RESHAPE",
    "chunk": "CHUNK", "concat": "CONCAT",
    "dot": "DOT", "mean": "MEAN",
    "median": "MEDIAN",
    "@": "BREAKPOINT", "step": "STEP", "next": "NEXT", "continue": "CONTINUE", "stop": "STOP",
    "backtrace": "BACKTRACE",
    "transpose": "TRANSPOSE", "outer": "OUTER", "matmul": "MATMUL",
}

def run(code, default_library=True):
    machine = Machine()
    with contextlib.redirect_stderr(io.StringIO()):
        if default_library:
            assert machine.include_file("include/core.bo") and machine.include_file("include/std.bo")
        assert machine.execute(code)
    return machine.data


class SelectedStackPrimitives(unittest.TestCase):
    def test_generated_adapter_libraries_are_current(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "generate_adapters.py"), "--check"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_primitive_metadata_covers_registry_and_generates_adapters(self):
        names = set(generate_adapters.native_names())
        docs = generate_adapters.primitive_docs()
        self.assertEqual({doc["name"] for doc in docs}, names)
        core = generate_adapters.core_source(docs)
        for doc in docs:
            name = doc["name"]
            if name in generate_adapters.NO_DEFAULT_ADAPTERS:
                continue
            adapter = generate_adapters.default_adapter_doc(doc)
            self.assertIn(
                f";{adapter['name']} ( {adapter['effect']} ) {adapter['description']}",
                core,
            )
            self.assertIn(
                f"(() {name}) ({adapter['name']}) PUSH",
                core,
            )

    def test_kernel_primitives_require_a_selector(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(machine.execute("ADD"))
            self.assertTrue(machine.execute("1 2 () ADD"))
        self.assertEqual(machine.data, [3])

    def test_default_stack_requires_and_consumes_selector(self):
        self.assertEqual(run("1 2 () ADD"), [3])
        self.assertEqual(run("1 2 () DEPTH"), [1, 2, 2])

        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(machine.execute("1 2 ADD"))
        self.assertEqual(machine.data, [1, 2])

    def test_named_stack_uses_push_and_pop_boundaries(self):
        self.assertEqual(
            run("7 (WORK) PUSH 8 (WORK) PUSH (WORK) ADD (WORK) POP"),
            [15],
        )
        self.assertEqual(
            run("7 (WORK) PUSH (WORK) TOP (WORK) POP"),
            [7, 7],
        )

    def test_stack_inspection_transfers_to_default(self):
        self.assertEqual(run("42 () TOP () SNAPSHOT () DEPTH"), [42, 42, [42, 42], 3])
        self.assertEqual(run("42 () POP 7 () UNIT"), [42, [7]])
        self.assertEqual(run("7 (WORK) PUSH 8 (WORK) PUSH (WORK) TOP "
                             "(WORK) SNAPSHOT (WORK) DEPTH (WORK) POP (WORK) POP"),
                         [8, [7, 8], 2, 8, 7])
        self.assertEqual(run("(MISSING) SNAPSHOT (MISSING) DEPTH"), [[], 0])
        self.assertEqual(run("7 (WORK) PUSH (WORK) UNIT (WORK) POP"), [[7]])
        self.assertEqual(run("(A B) unit () unit"), [[[Word("A"), Word("B")]], [[]]])
        self.assertEqual(run("(unit) POP"), [[[], Word("UNIT")]])

    def test_stack_key_predicates_and_presence(self):
        self.assertEqual(
            run('"include/value.bo" require () isword (WORK) isword (42) isword '
                "(WORK OTHER) isword 42 isword"),
                         [1, 1, 0, 0, 0])
        self.assertEqual(
            run('"include/std.bo" require 42 isnumber () isnumber () islist (WORK) islist '
                "(WORK) isunit (WORK OTHER) isunit 42 isunit 2 isinteger 2.5 isinteger () isinteger"),
            [1, 0, 1, 1, 1, 0, 0, 1, 0, 0],
        )
        self.assertEqual(
            run("() EXISTS (MISSING) EXISTS (ADD) EXISTS "
                "1 (WORK) PUSH (WORK) EXISTS (WORK) CLEAR (WORK) EXISTS"),
            [1, 0, 1, 1, 1],
        )
        self.assertEqual(
            run('"include/std.bo" require (((MISSING) EXISTS) (MISSING) (42) ifte) '
                "(guard) PUSH guard"),
            [42],
        )
        self.assertEqual(
            run("(42 EXISTS) () catch")[-1][:2],
            [[Word("Type-Error")], [Word("EXISTS")]],
        )
        self.assertEqual(
            run("(42 LOCKED) () catch")[-1][:2],
            [[Word("Type-Error")], [Word("LOCKED")]],
        )

    def test_locked_stack_allows_reads_but_rejects_mutation(self):
        operations = ("DROP", "PICK", "ROLL", "UNIT", "CONSL", "CONSR", "UNCONSL",
                      "UNCONSR", "TYPE", "RATIO", "APPLY", "IFTE", "LOOP", "PARALLEL",
                      "ADD", "SUB",
                      "MUL", "DIV", "IDIV", "POW", "RANGE", "EQUAL",
                      "BROADCAST",
                      "ARRAY", "SHAPE", "RANK", "RESHAPE", "FETCH", "STORE",
                      "CHUNK", "CONCAT",
                      "REDUCE", "DOT", "MEAN", "MEDIAN", "TRANSPOSE",
                      "OUTER", "MATMUL",
                      "OPEN", "CLOSE", "READ",
                      "WRITE", "INCLUDE", "INCLUDED", "CATCH", "THROW", "EXIT", "UNITTYPE",
                      "WORD", "TEXT", "CLEAR")
        for operation in operations:
            with self.subTest(operation=operation):
                data = run(f"1 (WORK) PUSH 2 (WORK) PUSH (WORK) LOCK "
                           f"((WORK) {operation}) () catch (WORK) SNAPSHOT (WORK) TOP (WORK) DEPTH")
                self.assertEqual(data[0][0], [Word("Permission-Error")])
                self.assertEqual(data[0][1], [Word(operation)])
                self.assertEqual(data[1:], [[1, 2], 2, 2])
        self.assertEqual(run("1 (WORK) PUSH (WORK) LOCK (WORK) UNLOCK "
                             "(WORK) DROP (WORK) SNAPSHOT"), [[]])
        self.assertEqual(run("1 (WORK) PUSH (WORK) LOCK (2 (WORK) PUSH) () catch "
                             "(WORK) SNAPSHOT")[-1], [1])
        self.assertEqual(run("1 (WORK) PUSH (WORK) LOCK ((WORK) POP) () catch "
                             "(WORK) SNAPSHOT")[-1], [1])

    def test_transfer_errors_restore_selector(self):
        for operation in ("TOP", "POP"):
            with self.subTest(operation=operation):
                data = run(f"((MISSING) {operation}) () catch")
                self.assertEqual(data[0], [Word("MISSING")])
                self.assertEqual(data[1][0], [Word("Stack-Error")])
                self.assertEqual(data[1][1], [Word(operation)])

    def test_split(self):
        cases = (
            ("()", 0, [], []),
            ("(1 2 3)", 0, [], [1, 2, 3]),
            ("(1 2 3)", 2, [1, 2], [3]),
            ("(1 2 3)", 3, [1, 2, 3], []),
            ("(A (B C) 3)", 2, [Word("A"), [Word("B"), Word("C")]], [3]),
        )
        for source, count, left, right in cases:
            with self.subTest(source=source, count=count):
                data = run(
                    '"include/std.bo" require '
                    f"{source} {count} split"
                )
                self.assertEqual(data, [left, right])

    def test_ifte_requires_a_selector_and_respects_named_stacks(self):
        self.assertEqual(run("(1) (11) (22) () IFTE (0) (11) (22) () IFTE"), [11, 22])
        self.assertEqual(
            run("(1) (WORK) PUSH (11) (WORK) PUSH (22) (WORK) PUSH (WORK) IFTE"),
            [11],
        )
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(machine.execute("(1) (11) (22) IFTE"))

    def test_loop_takes_its_programs_from_the_selected_stack(self):
        self.assertEqual(run("0 (dup 3 <) (1 +) () LOOP"), [3])
        self.assertEqual(
            run("(dup 2 <) (WORK) PUSH (1 +) (WORK) PUSH 0 (WORK) LOOP"),
            [2],
        )
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(machine.execute("(1) (2) LOOP"))

    def test_loop_errors_name_loop_and_keep_the_value(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.include_file("include/std.bo"))
            for source, kind in (("(((a)) (1) () LOOP) () catch", "Type-Error"),
                                 ("(() (1) () LOOP) () catch", "Stack-Error"),
                                 ("(1 (1) () LOOP) () catch", "Type-Error")):
                machine.data.clear()
                self.assertTrue(machine.execute(source))
                self.assertEqual(machine.data[-1][0], [Word(kind)], source)
                self.assertEqual(machine.data[-1][1], [Word("LOOP")], source)

    def test_errors_identify_word_dispatch_and_selected_primitives(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.include_file("include/std.bo"))
            self.assertTrue(machine.execute("(1 2 ADD) () catch"))
            self.assertEqual(machine.data[:2], [1, 2])
            self.assertEqual(machine.data[-1][0], [Word("Type-Error")])
            self.assertEqual(machine.data[-1][1], [Word("ADD")])
            machine.data.clear()
            self.assertTrue(machine.execute("(IFTE) () catch"))
            self.assertEqual(machine.data[-1][0], [Word("Stack-Error")])
            self.assertEqual(machine.data[-1][1], [Word("IFTE")])
            machine.data.clear()
            self.assertTrue(machine.execute("(WORD) () catch"))
            self.assertEqual(machine.data[-1][0], [Word("Stack-Error")])
            self.assertEqual(machine.data[-1][1], [Word("WORD")])
            machine.data.clear()
            self.assertTrue(machine.execute("(NOT-DEFINED) () catch"))
            self.assertEqual(machine.data[-1][0], [Word("Existence-Error")])
            self.assertEqual(machine.data[-1][1], [Word("WORD")])

    def test_lowercase_wrappers_select_the_default_stack(self):
        self.assertEqual(run("1 2 + 9 0.5 ^"), [3, 3])

    def test_initial_wrappers_are_unlocked_ordinary_definitions(self):
        machine = Machine()
        self.assertEqual(machine.data, [])
        for name in WRAPPERS:
            with self.subTest(name=name):
                self.assertNotIn(canon([Word(name)]), machine.stacks)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.include_file("include/core.bo"))
        self.assertNotIn(canon([Word("isword")]), machine.stacks)
        for name, primitive in WRAPPERS.items():
            with self.subTest(name=name):
                key = canon([Word(name)])
                self.assertEqual(machine.stacks[key], [[[], Word(primitive)]])
                self.assertNotIn(key, machine.locked)
        self.assertEqual(run("(+) POP (::) POP"),
                         [[[], Word("ADD")],
                          [[], Word("RANGE")]])

    def test_stack_primitives_work_without_a_library_and_are_locked(self):
        self.assertEqual(
            run("42 (WORK) PUSH 7 (WORK) PUSH (WORK) DEPTH (WORK) POP (WORK) POP",
                default_library=False),
            [2, 7, 42],
        )
        data = run("(1 (DROP) PUSH) () () CATCH", default_library=False)
        self.assertEqual(data[-1][0], [Word("Permission-Error")])

    def test_library_loading_does_not_replace_wrapper_redefinitions(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.execute("(99) (+) PUSH"))
            self.assertTrue(machine.include_file("include/std.bo"))
            self.assertTrue(machine.execute("+ (+) POP 1 2 +"))
        self.assertEqual(machine.data, [99, [99], 3])
        self.assertEqual(machine.stacks[canon([Word("+")])], [[[], Word("ADD")]])

    def test_library_loading_does_not_restore_removed_wrappers(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.execute("(^) POP drop"))
            self.assertTrue(machine.include_file("include/std.bo"))
            self.assertTrue(machine.execute("(^) () catch"))
        self.assertEqual(machine.data[0][0], [Word("Existence-Error")])
        self.assertEqual(machine.data[0][2], [[Word("^")]])

    def test_other_library_words_require_explicit_include(self):
        machine = Machine()
        error_output = io.StringIO()
        with contextlib.redirect_stderr(error_output):
            self.assertFalse(machine.execute("dup"))
        self.assertIn("Existence-Error", error_output.getvalue())

    def test_pow_supports_general_finite_real_exponents(self):
        self.assertEqual(run("9 0.5 () POW"), [3])
        self.assertEqual(run("2 -3 () POW"), [0.125])

        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(machine.execute("-2 0.5 () POW"))
            self.assertFalse(machine.execute("0 -1 () POW"))

    def test_exit_requires_a_portable_integer_status(self):
        for code, error in (("1.5 () EXIT", "Type-Error"), ("256 () EXIT", "Domain-Error"),
                            ("-1 () EXIT", "Domain-Error")):
            with self.subTest(code=code):
                machine = Machine()
                error_output = io.StringIO()
                with contextlib.redirect_stderr(error_output):
                    self.assertFalse(machine.execute(code))
                self.assertIn(error, error_output.getvalue())

    def test_aggregate_load_does_not_leave_documentation_values(self):
        machine = Machine()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(machine.include_file("include/core.bo"))
            self.assertTrue(machine.include_file("include/std.bo"))
        self.assertEqual(machine.data, [])

    def test_modules_load_with_explicit_dependencies(self):
        cases = (
            ("stack.bo", "1 dup", [1, 1]),
            ("logic.bo", "1 2 <", [1]),
            ("math.bo", "-2 abs", [2]),
            ("list.bo", "(1 2) len", [2]),
            ("io.bo", "0 ?", []),
            ("dict.bo", "5 (VALUE) set (VALUE) POP", [5]),
            ("dict.bo", "5 (VALUE) set 6 (VALUE) set (VALUE) get (VALUE) size", [6, 1]),
            ("stream.bo", "stdout", [1]),
            ("io.bo", "1 emit", []),
            ("std.bo", "1 2 +", [3]),
        )
        for module, code, expected in cases:
            with self.subTest(module=module):
                machine = Machine()
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    self.assertTrue(machine.include_file("include/core.bo"))
                    self.assertTrue(machine.include_file(f"include/{module}"))
                    self.assertTrue(machine.execute(code))
                self.assertEqual(machine.data, expected)
