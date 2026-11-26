"""The Bo machine (README sections 4-6)."""

import io
import math
import multiprocessing
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .lower import LoweringError, lower_word_forms
from .render import render
from .units import cons_unit, uncons_unit
from .words import text_to_word, unit_type, word_to_text
from .values import (
    BoError,
    BoRethrow,
    Word,
    canon,
    norm,
    from_str,
    is_int,
    is_plain_number,
    to_str,
)

WORD_EXCEPTION_KEY = canon([Word("EXCEPTION")])
WORD_DIAGNOSTICS_KEY = canon([Word("DIAGNOSTICS")])


def _owned_by(key, owner):
    """Whether `key` names the stack of a private word of file `owner`."""
    if not (key[0] == "l" and len(key[1]) == 1):
        return False
    item = key[1][0]
    return item[0] == "w" and len(item) == 3 and item[2] == owner


class _CatchFrame:
    """Control-stack marker left by CATCH: normal completion does nothing, errors unwind to it."""

    def __init__(self, handler):
        self.handler = handler

    def __call__(self):
        pass


class _LambdaFrame:
    """Control-stack marker left by LAMBDA: it carries the label and program that REC re-enters."""

    __slots__ = ("label", "program")

    def __init__(self, label, program):
        self.label, self.program = label, program

    def __call__(self):
        pass


class _Site:
    """A compiled call that resolves its stack when executed."""

    __slots__ = ("name", "key", "native")

    def __init__(self, name, key, native):
        self.name, self.key, self.native = name, key, native


class _CallFrame:
    def __init__(self, programs):
        self.programs = programs
        self.stage = "setup"
        self.error = None


CODE_CACHE_LIMIT = 200_000
MAX_RANGE_LENGTH = 2**32 - 1
_PARALLEL_BASE = None


class AbortSignal(Exception):
    """Unwinds to top level (ABORT and the default error handler)."""


@dataclass(frozen=True)
class ExecutionResult:
    """The observable outcome of one top-level source execution."""

    success: bool
    data: list
    error: Optional[list]


def _parallel_init(machine):
    global _PARALLEL_BASE
    _PARALLEL_BASE = machine


def _parallel_apply(item, program):
    base = _PARALLEL_BASE
    worker = Machine()
    worker.stacks = {key: list(stack) for key, stack in base.stacks.items()}
    worker.locked = set(base.locked)
    worker.streams = dict(base.streams)
    worker.next_stream = base.next_stream
    worker.source, worker.line = base.source, base.line
    worker.included = set(base.included)
    worker.owners = dict(base.owners)
    worker.private_words = base.private_words
    worker._include_roots = list(base._include_roots)
    worker.data = [item]

    marker = object()
    attempt = [program, [], Word("APPLY")]
    handler = [marker]
    try:
        worker.run([attempt, handler, [], Word("CATCH")])
    except (AbortSignal, SystemExit):
        error = [
            [Word("Evaluation-Error")],
            [Word("PARALLEL")],
            [],
            from_str(worker.source),
            worker.line,
        ]
        return False, error
    if worker.data and worker.data[-1] is marker:
        return False, worker.data[-2]
    return True, worker.data


class Machine:
    def __init__(self):
        self.data = []
        self.stacks = {}
        self.locked = set()
        self.word_natives = {}
        self.control = []
        self._suspended = []
        self.streams = {}
        self.next_stream = 3
        self.source = "stdin"
        self.line = 1
        self.handling = False
        self._selected = None
        self._lower = lower_word_forms
        self._exception_key = WORD_EXCEPTION_KEY
        self.stacks[WORD_DIAGNOSTICS_KEY] = []
        self.locked.add(WORD_DIAGNOSTICS_KEY)
        self.included = set()
        self.owners = {}  # resolved path of a source file -> its id (the owner of its private words)
        # What a file's load leaves, so that loading it again can take it out first (see _wipe_file)
        self.cur_file = 0  # id of the file whose load is running, 0 when none
        self._owners = {}  # stack key -> file id of each item the loads pushed (a prefix of the stack)
        self._creators = {}  # stack key -> id of the file whose load made the stack
        self._locked_by = {}  # stack key -> id of the file whose load locked it
        self._unlocked_for = {}  # stack key -> id of the file whose reload unlocked it
        self._loading = []  # resolved paths of the files being loaded, outermost first
        self.private_words = not os.environ.get("BO_NO_PRIVATE")
        self._include_roots = []
        # the directory that holds include/: the last place a relative include path is looked up
        self.home = Path(os.environ.get("BO_HOME") or Path(__file__).resolve().parents[2])
        self._codes = {}
        self._keys = {}
        # a host that can show where a program is (the Jupyter kernel) sets this: called with the machine
        self.breakpoint_hook = None
        self._next_forms = None  # (forms, index) of the top-level forms still to run, for that hook
        self._register()

    # ----------------------------------------------------------------- running

    def run(self, program):
        """Run a program (a list of values) on a fresh control stack."""
        saved = self.control
        self._suspended.append(saved)
        self.control = [[self._compile(program), 0, program, None]]
        try:
            self._loop()
        finally:
            self.control = saved
            self._suspended.pop()

    def _compile(self, lst):
        """Compile words to named call sites and retain other values as literals."""
        ops = []
        for element in lst:
            kind = type(element)
            if kind is Word:
                key = canon([element])
                ops.append(_Site(element, key, self.word_natives.get(key)))
            else:
                ops.append(element)
        return ops

    def _code(self, lst):
        """Compiled form of a list, cached by identity (lists are never mutated in place)."""
        entry = self._codes.get(id(lst))
        if entry is not None and entry[0] is lst:
            return entry[1]
        ops = self._compile(lst)
        if len(self._codes) >= CODE_CACHE_LIMIT:
            self._codes.clear()
        self._codes[id(lst)] = (lst, ops)
        return ops

    def _key(self, name):
        """Stack key of a name list, cached by identity."""
        entry = self._keys.get(id(name))
        if entry is not None and entry[0] is name:
            return entry[1]
        key = canon(name)
        if len(self._keys) >= CODE_CACHE_LIMIT:
            self._keys.clear()
        self._keys[id(name)] = (name, key)
        return key

    def _loop(self):
        ctl = self.control
        while True:
            try:
                self._steps(ctl)
                return
            except BoError as error:
                self._fail(error)
            except BoRethrow as error:
                self._dispatch_error(error.error)

    def _steps(self, ctl):
        data = self.data
        while ctl:
            top = ctl[-1]
            if isinstance(top, _CallFrame):
                if top.stage == "setup":
                    top.stage = "body"
                    self._enter(top.programs[1])
                elif top.stage == "body":
                    top.stage = "cleanup"
                    self._enter(top.programs[3])
                else:
                    ctl.pop()
                    if top.stage == "error-cleanup":
                        data.append(top.error)
                        self._enter(top.programs[2])
                continue
            if type(top) is not list:
                ctl.pop()
                top()
                continue
            ops, i = top[0], top[1]
            if i >= len(ops):
                ctl.pop()
                continue
            top[1] = i + 1
            op = ops[i]
            if type(op) is _Site:
                stack = self.stacks.get(op.key, [])
                if stack:
                    self._enter(stack[-1], op.name)
                elif op.native is not None:
                    self._call_native(*op.native)
                else:
                    raise BoError("Existence-Error", [[op.name]], "WORD")
            else:
                data.append(op)

    def _trim(self):
        """Drop exhausted frames so that tail calls do not grow the control stack."""
        ctl = self.control
        while ctl:
            top = ctl[-1]
            if type(top) is list and top[1] >= len(top[0]):
                ctl.pop()
            else:
                break

    def _frame(self, lst, name=None):
        """A control-stack frame: the compiled ops, the index of the next one, the list and the
        word whose call started it (the last two are what BACKTRACE reports)."""
        return [self._code(lst), 0, lst, name]

    def _enter(self, element, name=None):
        """Execute a stack element: a list is unwrapped into the program, a number is pushed."""
        if type(element) is list:
            self._trim()
            self.control.append(self._frame(element, name))
        else:
            self.data.append(element)

    def _call_native(self, name, arity, fn, transfer=False):
        data = self.data
        if transfer:
            if len(data) < arity:
                raise BoError("Stack-Error", where=name)
            args = data[len(data) - arity :]
            del data[len(data) - arity :]
            try:
                result = fn(*args)
            except BoError as error:
                data.extend(args)
                error.where = error.where or name
                raise
            if result:
                data.extend(result)
            return
        if not data:
            raise BoError("Stack-Error", where=name)
        selector = data[-1]
        try:
            stack, key = self._ref(selector, create=True)
        except BoError as error:
            error.where = error.where or name
            raise
        data.pop()
        if key is not None and key in self.locked and (arity or name in ("CLEAR", "DELETE")):
            raise BoError("Permission-Error", [selector], name)
        selected = self.data
        self.data = stack
        self._selected = key
        try:
            if len(stack) < arity:
                raise BoError("Stack-Error", where=name)
            args = stack[len(stack) - arity :]
            del stack[len(stack) - arity :]
            try:
                result = fn(*args)
            except BoError as error:
                stack.extend(args)
                error.where = error.where or name
                raise
            if result:
                stack.extend(result)
        except BoError:
            raise
        finally:
            self.data = selected
            self._selected = None
            if key is not None and name not in ("LOCK", "UNLOCK"):
                # the operation may have moved items around: who pushed them is no longer known
                self._owners.pop(key, None)

    # ------------------------------------------------------------------ errors

    def _fail(self, error):
        error_list = [
            [Word(error.kind)],
            [Word(error.where or "WORD")],
            list(error.data),
            from_str(self.source),
            self.line,
        ]
        self.stacks[WORD_DIAGNOSTICS_KEY].append(error_list)
        self._dispatch_error(error_list)

    def _dispatch_error(self, error_list):
        self.data.append(error_list)
        for depth in range(len(self.control) - 1, -1, -1):
            frame = self.control[depth]
            if isinstance(frame, _CallFrame) and frame.stage == "body":
                removed = self.control[depth + 1:]
                del self.control[depth + 1:]
                if self._end_handler in removed:
                    self.handling = False
                frame.error = self.data.pop()
                frame.stage = "error-cleanup"
                self._enter(frame.programs[3])
                return
            if isinstance(frame, _CatchFrame):
                removed = self.control[depth:]
                del self.control[depth:]
                if self._end_handler in removed:
                    self.handling = False
                self._enter(frame.handler)
                return
        if any(self._catches(control) for control in self._suspended):
            # an enclosing run (this one is an INCLUDE nested in it) will catch the error
            if self._end_handler in self.control:
                self.handling = False
            self.data.pop()
            raise BoRethrow(error_list)
        handler = self.stacks.get(self._exception_key)
        if self.handling or not handler:
            self._default_handler(error_list)
        self.handling = True
        self.control.append(self._end_handler)
        self._enter(handler[-1])

    @staticmethod
    def _catches(control):
        return any(isinstance(frame, _CatchFrame)
                   or (isinstance(frame, _CallFrame) and frame.stage == "body")
                   for frame in control)

    def _end_handler(self):
        self.handling = False

    def _default_handler(self, error_list):
        self.data.pop()
        kind, where, data, source, line = error_list
        sys.stderr.write(
            f"Uncaught Exception -- {to_str(source)}:{line} {kind[0].name} "
            f"({where[0].name}) {render(data)}\n"
        )
        raise AbortSignal

    # ----------------------------------------------------------------- loading

    def _lower_file(self, text, source, first_line=1):
        """Lower the text of a file, whose `__` words are private to it.

        A file that is loaded again starts from scratch: the private words of its earlier load go.
        """
        if not self.private_words:
            return self._lower(text, first_line)
        owner = self._file_id(source)
        forms = self._lower(text, first_line, owner)
        for key in [key for key in self.stacks if _owned_by(key, owner)]:
            del self.stacks[key]
        return forms

    def _file_id(self, source):
        """The id of a source file: it stays the same for the life of the machine."""
        return self.owners.setdefault(self._resolved(source), len(self.owners) + 1)

    def _wipe_file(self, file):
        """Take out what the earlier load of a file left, before it is loaded again.

        These are the items it pushed, the locks it set and the stacks it made, once nothing is left
        in them. What other files, or the program after the load, put in the same stacks stays.
        """
        if not file:
            return
        for key in [key for key, owner in self._locked_by.items() if owner == file]:
            self.locked.discard(key)
            del self._locked_by[key]
            self._unlocked_for[key] = file
        for key, tags in list(self._owners.items()):
            stack = self.stacks.get(key)
            if stack is None or key in self.locked:
                continue
            count = min(len(tags), len(stack))
            kept = [(item, tag) for item, tag in zip(stack[:count], tags[:count]) if tag != file]
            if len(kept) < count:
                stack[:count] = [item for item, _ in kept]
                tags[:] = [tag for _, tag in kept]
        for key in [key for key, owner in self._creators.items() if owner == file]:
            stack = self.stacks.get(key)
            if stack is not None and not stack and key not in self.locked:
                del self.stacks[key]
                del self._creators[key]
                self._owners.pop(key, None)
                self._unlocked_for.pop(key, None)

    def _finish_load(self, file, failed):
        """End the load of a file (0: every load in progress, which an error abandoned).

        A lock that the reload lifted and the file did not set again stays lifted, unless the load
        failed, which puts it back.
        """
        for key, owner in list(self._unlocked_for.items()):
            if file and owner != file:
                continue
            if failed and key not in self.locked and key in self.stacks:
                self.locked.add(key)
                self._locked_by[key] = owner
            del self._unlocked_for[key]

    def execute(self, text, source="stdin", first_line=1, file=False):
        """Run source text at top level. Returns False if an error aborted it.

        `file` marks the text of a source file, whose `__` words are private to it.
        """
        try:
            forms = (self._lower_file(text, source, first_line) if file
                     else self._lower(text, first_line))
        except LoweringError as error:
            saved_source, saved_line, saved_control = self.source, self.line, self.control
            self.source, self.line = source, error.line
            self.control = []
            try:
                self._fail(BoError("Syntax-Error", [from_str(error.msg)], "LOWER"))
                self._loop()
            except AbortSignal:
                pass
            finally:
                self.source, self.line, self.control = saved_source, saved_line, saved_control
                self.handling = False
            return False
        file_id = self._file_id(source) if file else 0
        outer_file = self.cur_file
        loading = len(self._loading)
        self._wipe_file(file_id)
        self.cur_file = file_id
        if file:
            self._loading.append(self._resolved(source))
        try:
            self._run_forms(forms, source)
        except AbortSignal:
            self.cur_file = outer_file
            self._finish_load(0, True)
            return False
        finally:
            del self._loading[loading:]
            self.cur_file = outer_file
            self.handling = False
        self._finish_load(file_id, False)
        return True

    def execute_result(self, text, source="stdin", first_line=1):
        """Run source text and retain the error value emitted by a failed execution."""
        diagnostics = self.stacks[WORD_DIAGNOSTICS_KEY]
        previous = len(diagnostics)
        success = self.execute(text, source, first_line)
        error = diagnostics[-1] if not success and len(diagnostics) > previous else None
        return ExecutionResult(success, list(self.data), error)

    def stack_snapshot(self):
        """Return the default stack and nonempty named stacks for host-side presentation."""
        named = {}
        for key, stack in self.stacks.items():
            if not stack:
                continue
            name = self._stack_name(key)
            if name is not None:
                named[name] = list(stack)
        return {"default": list(self.data), "named": named}

    @staticmethod
    def _stack_name(key):
        if not (isinstance(key, tuple) and len(key) == 2 and key[0] == "l" and len(key[1]) == 1):
            return None
        item = key[1][0]
        if isinstance(item, tuple) and len(item) == 2 and item[0] == "w":
            return item[1]
        return None

    def include_file(self, path):
        path = self._include_path(path)
        self._remember_include_root(path)
        resolved = self._resolved(path)
        self.included.add(resolved)
        try:
            text = Path(path).read_text(encoding="utf-8")
        except OSError as error:
            sys.stderr.write(f"Cannot read {path}: {error}\n")
            return False
        ok = self.execute(text, str(path), file=True)
        if not ok:
            self.included.discard(resolved)
        return ok

    def add_include_root(self, path):
        """Add a directory searched for relative include paths."""
        root = Path(path).resolve()
        if root not in self._include_roots:
            self._include_roots.append(root)

    def _run_forms(self, forms, source):
        saved = self.source, self.line, self._next_forms
        self.source = source
        try:
            for index, (line, items) in enumerate(forms):
                self.line = line
                self._next_forms = (forms, index + 1)
                self.run(items)
        finally:
            self.source, self.line, self._next_forms = saved

    # -------------------------------------------------------------- primitives

    def _register(self):
        table = {
            "PUSH": (2, self.n_push, True),
            "LAMBDA": (2, self.n_lambda, True),
            "REC": (1, self.n_rec, True),
            "POP": (1, self.n_pop, True),
            "TOP": (1, self.n_top, True),
            "SNAPSHOT": (1, self.n_see, True),
            "DEPTH": (1, self.n_depth, True),
            "EXISTS": (1, self.n_exists, True),
            "LOCKED": (1, self.n_locked, True),
            "CLEAR": (0, self.n_clr, False),
            "LEXICON": (0, self.n_lexicon),
            "DELETE": (0, self.n_delete),
            "LOCK": (0, self.n_lock, False),
            "UNLOCK": (0, self.n_unlock, False),
            "DROP": (1, lambda a: None),
            "PICK": (1, self.n_pick),
            "ROLL": (1, self.n_roll),
            "UNIT": (1, lambda a: [[a]]),
            "CONSL": (2, lambda lst, a: [[a] + self._list(lst)]),
            "CONSR": (2, lambda lst, a: [self._list(lst) + [a]]),
            "UNCONSL": (1, lambda lst: self._uncons(lst, 0)),
            "UNCONSR": (1, lambda lst: self._uncons(lst, -1)),
            "TYPE": (1, self.n_type),
            "RATIO": (1, self.n_ratio),
            "APPLY": (1, self.n_apply),
            "IFTE": (3, self.n_ifte),
            "LOOP": (2, self.n_loop),
            "PARALLEL": (2, self.n_parallel),
            "ADD": (2, lambda a, b: self._arith(a, b, lambda x, y: x + y)),
            "SUB": (2, lambda a, b: self._arith(a, b, lambda x, y: x - y)),
            "MUL": (2, lambda a, b: self._arith(a, b, lambda x, y: x * y)),
            "DIV": (2, lambda a, b: self._arith(a, b, _divide)),
            "IDIV": (2, lambda a, b: self._arith(a, b, lambda x, y: x // y)),
            "POW": (2, lambda a, b: self._arith(a, b, math.pow)),
            "RANGE": (3, self.n_colon),
            "BROADCAST": (3, self.n_broadcast),
            "ARRAY": (2, self.n_tensor),
            "SHAPE": (1, self.n_shape),
            "RANK": (1, self.n_rank),
            "RESHAPE": (2, self.n_reshape),
            "FETCH": (2, self.n_tget),
            "STORE": (3, self.n_tset),
            "CHUNK": (2, self.n_tsplit),
            "CONCAT": (1, self.n_tconcat),
            "REDUCE": (3, self.n_reduce),
            "DOT": (2, self.n_tdot),
            "MEAN": (2, self.n_tmean),
            "MEDIAN": (2, self.n_tmedian),
            "TRANSPOSE": (1, self.n_ttranspose),
            "OUTER": (2, self.n_touter),
            "MATMUL": (2, self.n_tmatmul),
            "EQUAL": (2, lambda a, b: [1 if canon(a) == canon(b) else 0]),
            "OPEN": (2, self.n_open),
            "CLOSE": (1, self.n_close),
            "READ": (1, self.n_read),
            "WRITE": (2, self.n_write),
            "INCLUDE": (1, self.n_include),
            "INCLUDED": (1, self.n_included),
            "PARSE": (1, self.n_parse),
            "CATCH": (2, self.n_catch),
            "CALL": (4, self.n_call),
            "THROW": (2, self.n_throw),
            "RETHROW": (1, self.n_rethrow),
            "EXIT": (1, self.n_exit),
            "ABORT": (0, self.n_abort),
            "BREAKPOINT": (0, self.n_breakpoint),
            "STEP": (0, self.n_resume),
            "NEXT": (0, self.n_resume),
            "CONTINUE": (0, self.n_resume),
            "STOP": (0, self.n_resume),
            "BACKTRACE": (0, self.n_backtrace),
        }
        word_table = dict(table)
        word_table.update({
            "CONSL": (2, lambda lst, unit: [cons_unit(lst, unit)]),
            "CONSR": (2, lambda lst, unit: [cons_unit(lst, unit, right=True)]),
            "UNCONSL": (1, lambda lst: list(uncons_unit(lst))),
            "UNCONSR": (1, lambda lst: list(uncons_unit(lst, right=True))),
            "UNITTYPE": (1, lambda unit: [unit_type(unit)]),
            "WORD": (1, lambda text: [text_to_word(text)]),
            "TEXT": (1, lambda unit: [word_to_text(unit)]),
        })
        for name, entry in word_table.items():
            arity, fn = entry[:2]
            transfer = entry[2] if len(entry) == 3 else False
            key = canon([Word(name)])
            self.word_natives[key] = (name, arity, fn, transfer)
            self.locked.add(key)
    def _ref(self, ref, create=False):
        """Resolve a stack reference: returns (list, key); key is None for the default stack."""
        if not isinstance(ref, list):
            raise BoError("Type-Error", [ref])
        if not ref:
            return self.data, None
        word_to_text(ref)
        key = self._key(ref)
        if create:
            stack = self.stacks.get(key)
            if stack is None:
                stack = self.stacks[key] = []
                if self.cur_file:
                    self._creators[key] = self.cur_file
                else:
                    self._creators.pop(key, None)
            return stack, key
        return self.stacks.get(key, []), key

    def _check_unlocked(self, ref, key):
        if key in self.locked:
            raise BoError("Permission-Error", [ref])

    def n_push(self, a, b):
        stack, key = self._ref(b, create=True)
        self._check_unlocked(b, key)
        stack.append(a)
        if self.cur_file and key is not None:
            tags = self._owners.setdefault(key, [])
            at = len(stack) - 1
            del tags[at:]
            tags.extend([0] * (at - len(tags)))
            tags.append(self.cur_file)

    def n_pop(self, b):
        stack, key = self._ref(b)
        self._check_unlocked(b, key)
        if not stack:
            raise BoError("Stack-Error", [b] if key else [])
        value = stack.pop()
        tags = self._owners.get(key)
        if tags is not None:
            del tags[len(stack):]
        return [value]

    def n_top(self, ref):
        stack, key = self._ref(ref)
        if not stack:
            raise BoError("Stack-Error", [ref] if key else [])
        return [stack[-1]]

    def n_see(self, ref):
        stack, _ = self._ref(ref)
        return [list(stack)]

    def n_depth(self, ref):
        stack, _ = self._ref(ref)
        return [len(stack)]

    def n_exists(self, ref):
        _, key = self._ref(ref)
        return [1 if key is None or key in self.stacks or key in self.word_natives else 0]

    def n_locked(self, ref):
        _, key = self._ref(ref)
        return [1 if key is not None and key in self.locked else 0]

    def n_lexicon(self):
        keys = set(self.stacks) | set(self.word_natives)
        names = sorted(name for key in keys if (name := self._stack_name(key)) is not None)
        return [[[Word(name)] for name in names]]

    def n_delete(self):
        # the data stack cannot be deleted; a locked stack, primitives included, was refused by the call
        if self._selected is None:
            raise BoError("Permission-Error", [[]])
        self.stacks.pop(self._selected, None)

    def n_clr(self):
        if self._selected is not None:
            self._check_unlocked([], self._selected)
        self.data.clear()

    def n_lock(self):
        if self._selected is None:
            raise BoError("Permission-Error", [[]])
        if self._selected not in self.locked:
            if self.cur_file:
                self._locked_by[self._selected] = self.cur_file
            else:
                self._locked_by.pop(self._selected, None)
        self.locked.add(self._selected)

    def n_unlock(self):
        if self._selected is not None:
            self.locked.discard(self._selected)
            self._locked_by.pop(self._selected, None)

    def _index(self, n):
        if not is_int(n):
            raise BoError("Type-Error", [n])
        if n < 0 or n >= len(self.data):
            raise BoError("Stack-Error", [n])

    def n_pick(self, n):
        self._index(n)
        return [self.data[-1 - n]]

    def n_roll(self, n):
        self._index(n)
        return [self.data.pop(len(self.data) - 1 - n)]

    def _list(self, value):
        if not isinstance(value, list):
            raise BoError("Type-Error", [value])
        return value

    def _uncons(self, lst, end):
        lst = self._list(lst)
        if not lst:
            raise BoError("Stack-Error", [lst])
        rest = lst[1:] if end == 0 else lst[:-1]
        return [rest, lst[end]]

    def n_type(self, value):
        """0 number, 1 list, 2 word."""
        if isinstance(value, list):
            return [1]
        if isinstance(value, Word):
            return [2]
        return [0]

    def n_ratio(self, value):
        """Exact numerator and denominator of a number."""
        if not is_plain_number(value):
            raise BoError("Type-Error", [value])
        return [norm(x) for x in value.as_integer_ratio()] if type(value) is float else [value, 1]

    def n_apply(self, lst):
        if not isinstance(lst, list):
            raise BoError("Type-Error", [lst])
        self._enter(lst)

    def _label(self, ref):
        """The identity of a LAMBDA label: a word unit, or () for anonymous recursion."""
        if not isinstance(ref, list):
            raise BoError("Type-Error", [ref])
        if not ref:
            return None
        word_to_text(ref)
        return self._key(ref)

    def n_lambda(self, program, selector):
        if not isinstance(program, list):
            raise BoError("Type-Error", [program])
        label = self._label(selector)
        control = self.control
        while True:
            self._trim()
            # an exhausted marker of the same lambda is interchangeable with the new one:
            # re-entering the program through either runs the same code
            top = control[-1] if control else None
            if type(top) is _LambdaFrame and top.label == label and top.program is program:
                control.pop()
            else:
                break
        control.append(_LambdaFrame(label, program))
        control.append(self._frame(program))

    def n_rec(self, selector):
        label = self._label(selector)
        for frame in reversed(self.control):
            if type(frame) is _LambdaFrame and frame.label == label:
                self._trim()
                self.control.append(self._frame(frame.program))
                return
        raise BoError("Existence-Error", [selector])

    def n_ifte(self, cond, then, otherwise):
        for block in (cond, then, otherwise):
            if not isinstance(block, list):
                raise BoError("Type-Error", [block])

        def branch():
            if not self.data:
                raise BoError("Stack-Error", where="IFTE")
            truth = self.data.pop()
            if not is_plain_number(truth):
                self.data.append(truth)
                raise BoError("Type-Error", [truth], "IFTE")
            self._enter(then if truth > 0 else otherwise)

        self._trim()
        self.control.append(branch)
        self.control.append(self._frame(cond))

    def n_loop(self, cond, body):
        for block in (cond, body):
            if not isinstance(block, list):
                raise BoError("Type-Error", [block])

        def test():
            if not self.data:
                raise BoError("Stack-Error", where="LOOP")
            truth = self.data.pop()
            if not is_plain_number(truth):
                self.data.append(truth)
                raise BoError("Type-Error", [truth], "LOOP")
            if truth > 0:
                self.control.append(again)
                self._enter(body)

        def again():
            self.control.append(test)
            self._enter(cond)

        self._trim()
        again()

    def n_parallel(self, inputs, program):
        if not isinstance(inputs, list):
            raise BoError("Type-Error", [inputs])
        if not isinstance(program, list):
            raise BoError("Type-Error", [program])
        if not inputs:
            return [[]]
        if "fork" not in multiprocessing.get_all_start_methods():
            raise BoError("Evaluation-Error", [inputs], "PARALLEL")

        workers = min(len(inputs), os.cpu_count() or 1)
        try:
            with ProcessPoolExecutor(
                max_workers=workers,
                mp_context=multiprocessing.get_context("fork"),
                initializer=_parallel_init,
                initargs=(self,),
            ) as pool:
                outcomes = list(pool.map(_parallel_apply, inputs, [program] * len(inputs)))
        except (BrokenProcessPool, OSError) as error:
            raise BoError("Io-Error", [from_str(str(error))])

        results = []
        for succeeded, result in outcomes:
            if not succeeded:
                self.stacks[WORD_DIAGNOSTICS_KEY].append(result)
                raise BoRethrow(result)
            results.append(result)
        return [results]

    def _arith(self, a, b, op):
        if not (is_plain_number(a) and is_plain_number(b)):
            raise BoError("Type-Error", [a, b])
        try:
            result = op(a, b)
        except (ValueError, ZeroDivisionError):
            raise BoError("Domain-Error", [a, b])
        except OverflowError:
            raise BoError("Evaluation-Error", [a, b])
        if isinstance(result, float) and not math.isfinite(result):
            raise BoError("Evaluation-Error", [a, b])
        return [norm(result)]

    def n_colon(self, start, step, end):
        return [self._range(start, step, end, [start, step, end])]

    @staticmethod
    def _shape(shape, operands):
        if not isinstance(shape, list):
            raise BoError("Type-Error", operands)
        if any(not is_int(dimension) for dimension in shape):
            raise BoError("Type-Error", operands)
        if any(dimension < 0 for dimension in shape):
            raise BoError("Domain-Error", operands)
        size = 1
        for dimension in shape:
            if dimension and size > MAX_RANGE_LENGTH // dimension:
                raise BoError("Resource-Error", operands)
            size *= dimension
        return tuple(shape), size

    def _tensor(self, tensor, operands):
        if not isinstance(tensor, list) or len(tensor) != 2:
            raise BoError("Type-Error", operands)
        data, shape = tensor
        if not isinstance(data, list) or not all(is_plain_number(value) for value in data):
            raise BoError("Type-Error", operands)
        if any(type(value) is float and not math.isfinite(value) for value in data):
            raise BoError("Domain-Error", operands)
        tensor_shape, size = self._shape(shape, operands)
        if len(data) != size:
            raise BoError("Shape-Error", operands)
        return data, tensor_shape

    def n_tensor(self, data, shape):
        self._tensor([data, shape], [data, shape])
        return [[data, shape]]

    def n_shape(self, tensor):
        _, shape = self._tensor(tensor, [tensor])
        return [list(shape)]

    def n_rank(self, tensor):
        _, shape = self._tensor(tensor, [tensor])
        return [len(shape)]

    def n_reshape(self, tensor, shape):
        data, _ = self._tensor(tensor, [tensor, shape])
        tensor_shape, size = self._shape(shape, [tensor, shape])
        if len(data) != size:
            raise BoError("Shape-Error", [tensor, shape])
        return [[data, list(tensor_shape)]]

    def _tensor_offset(self, tensor, indices, operands):
        data, shape = self._tensor(tensor, operands)
        if not isinstance(indices, list) or any(not is_int(index) for index in indices):
            raise BoError("Type-Error", operands)
        if len(indices) != len(shape):
            raise BoError("Shape-Error", operands)
        offset = 0
        for index, dimension in zip(indices, shape):
            if index < 0 or index >= dimension:
                raise BoError("Domain-Error", operands)
            offset = offset * dimension + index
        return data, offset

    def n_tget(self, tensor, indices):
        data, offset = self._tensor_offset(tensor, indices, [tensor, indices])
        return [data[offset]]

    def n_tset(self, tensor, indices, value):
        operands = [tensor, indices, value]
        data, offset = self._tensor_offset(tensor, indices, operands)
        if not is_plain_number(value):
            raise BoError("Type-Error", operands)
        if type(value) is float and not math.isfinite(value):
            raise BoError("Domain-Error", operands)
        updated = list(data)
        updated[offset] = value
        return [[updated, tensor[1]]]

    def n_tsplit(self, tensor, count):
        operands = [tensor, count]
        data, shape = self._tensor(tensor, operands)
        if not is_int(count):
            raise BoError("Type-Error", operands)
        if count <= 0:
            raise BoError("Domain-Error", operands)
        if count > MAX_RANGE_LENGTH:
            raise BoError("Resource-Error", operands)
        if len(shape) != 1:
            raise BoError("Shape-Error", operands)

        base, remainder = divmod(len(data), count)
        chunks = []
        offset = 0
        for index in range(count):
            length = base + (1 if index < remainder else 0)
            chunks.append([data[offset : offset + length], [length]])
            offset += length
        return [chunks]

    def n_tconcat(self, chunks):
        if not isinstance(chunks, list):
            raise BoError("Type-Error", [chunks])
        values = []
        for chunk in chunks:
            tensor = chunk[0] if isinstance(chunk, list) and len(chunk) == 1 else chunk
            data, shape = self._tensor(tensor, [chunks])
            if len(shape) != 1:
                raise BoError("Shape-Error", [chunks])
            if len(values) + len(data) > MAX_RANGE_LENGTH:
                raise BoError("Resource-Error", [chunks])
            values.extend(data)
        return [[values, [len(values)]]]

    def n_reduce(self, tensor, axis, unit):
        operands = [tensor, axis, unit]
        if not (isinstance(unit, list) and len(unit) == 1 and type(unit[0]) is Word):
            raise BoError("Type-Error", operands)
        word = unit[0]
        data, shape = self._tensor(tensor, operands)
        all_axes = axis == []
        if not all_axes and not is_int(axis):
            raise BoError("Type-Error", operands)
        if not all_axes and (axis < 0 or axis >= len(shape)):
            raise BoError("Domain-Error", operands)

        outer = 1 if all_axes else math.prod(shape[:axis])
        dimension = len(data) if all_axes else shape[axis]
        width = 1 if all_axes else math.prod(shape[axis + 1:])
        if outer * width > MAX_RANGE_LENGTH:
            raise BoError("Resource-Error", operands)
        if outer * width and not dimension:
            raise BoError("Domain-Error", operands)
        slices = [[data[(outer_index * dimension + index) * width + inner_index]
                   for index in range(dimension)]
                  for outer_index in range(outer) for inner_index in range(width)]

        operation = self._word_operation(word)
        values = None
        if operation is not None:
            try:
                values = []
                for items in slices:
                    result = items[0]
                    for value in items[1:]:
                        result = self._arith(result, value, operation)[0]
                    values.append(result)
            except BoError:
                values = None
        if values is None:
            marker = object()
            program = [[word], [marker], [], Word("CATCH")]
            saved = list(self.data)
            try:
                values = []
                for items in slices:
                    result = items[0]
                    for value in items[1:]:
                        result = self._word_call(program, marker, saved, result, value)
                    values.append(result)
            except BoRethrow:
                self.data.extend(operands)
                raise
        if all_axes:
            return [values[0]]
        return [[values, list(shape[:axis] + shape[axis + 1:])]]

    def n_tmean(self, tensor, axis):
        operands = [tensor, axis]
        data, shape = self._tensor(tensor, operands)
        all_axes = axis == []
        if not all_axes and not is_int(axis):
            raise BoError("Type-Error", operands)
        if not all_axes and (axis < 0 or axis >= len(shape)):
            raise BoError("Domain-Error", operands)
        outer = 1 if all_axes else math.prod(shape[:axis])
        dimension = len(data) if all_axes else shape[axis]
        width = 1 if all_axes else math.prod(shape[axis + 1:])
        if outer * width > MAX_RANGE_LENGTH:
            raise BoError("Resource-Error", operands)
        if not dimension:
            raise BoError("Domain-Error", operands)
        values = []
        for outer_index in range(outer):
            for inner_index in range(width):
                total = 0.0
                for index in range(dimension):
                    total += data[(outer_index * dimension + index) * width + inner_index]
                    if not math.isfinite(total):
                        raise BoError("Evaluation-Error", operands)
                values.append(norm(total / dimension))
        if all_axes:
            return [values[0]]
        return [[values, list(shape[:axis] + shape[axis + 1:])]]

    def n_tmedian(self, tensor, axis):
        operands = [tensor, axis]
        data, shape = self._tensor(tensor, operands)
        all_axes = axis == []
        if not all_axes and not is_int(axis):
            raise BoError("Type-Error", operands)
        if not all_axes and (axis < 0 or axis >= len(shape)):
            raise BoError("Domain-Error", operands)
        outer = 1 if all_axes else math.prod(shape[:axis])
        dimension = len(data) if all_axes else shape[axis]
        width = 1 if all_axes else math.prod(shape[axis + 1:])
        if outer * width > MAX_RANGE_LENGTH:
            raise BoError("Resource-Error", operands)
        if not dimension:
            raise BoError("Domain-Error", operands)
        values = []
        for outer_index in range(outer):
            for inner_index in range(width):
                slice_data = sorted(
                    data[(outer_index * dimension + index) * width + inner_index]
                    for index in range(dimension)
                )
                middle = dimension // 2
                if dimension % 2:
                    result = slice_data[middle]
                else:
                    result = slice_data[middle - 1] / 2 + slice_data[middle] / 2
                values.append(norm(result))
        if all_axes:
            return [values[0]]
        return [[values, list(shape[:axis] + shape[axis + 1:])]]

    def n_tdot(self, left, right):
        operands = [left, right]
        left_data, left_shape = self._tensor(left, operands)
        right_data, right_shape = self._tensor(right, operands)
        if len(left_shape) != 1 or len(right_shape) != 1:
            raise BoError("Shape-Error", operands)
        if len(left_data) != len(right_data):
            raise BoError("Shape-Error", operands)

        total = 0.0
        try:
            for left_value, right_value in zip(left_data, right_data):
                total += left_value * right_value
                if not math.isfinite(total):
                    raise BoError("Evaluation-Error", operands)
        except OverflowError:
            raise BoError("Evaluation-Error", operands)
        return [norm(total)]

    def n_ttranspose(self, tensor):
        data, shape = self._tensor(tensor, [tensor])
        if len(shape) != 2:
            raise BoError("Shape-Error", [tensor])
        rows, columns = shape
        values = [data[row * columns + column]
                  for column in range(columns) for row in range(rows)]
        return [[values, [columns, rows]]]

    def n_touter(self, left, right):
        operands = [left, right]
        left_data, left_shape = self._tensor(left, operands)
        right_data, right_shape = self._tensor(right, operands)
        if len(left_shape) != 1 or len(right_shape) != 1:
            raise BoError("Shape-Error", operands)
        if len(left_data) and len(right_data) > MAX_RANGE_LENGTH // len(left_data):
            raise BoError("Resource-Error", operands)
        values = []
        for left_value in left_data:
            for right_value in right_data:
                value = left_value * right_value
                if type(value) is float and not math.isfinite(value):
                    raise BoError("Evaluation-Error", operands)
                values.append(norm(value))
        return [[values, [len(left_data), len(right_data)]]]

    def n_tmatmul(self, left, right):
        operands = [left, right]
        left_data, left_shape = self._tensor(left, operands)
        right_data, right_shape = self._tensor(right, operands)
        if len(left_shape) != 2 or len(right_shape) != 2:
            raise BoError("Shape-Error", operands)
        rows, inner = left_shape
        right_inner, columns = right_shape
        if inner != right_inner:
            raise BoError("Shape-Error", operands)
        if rows and columns > MAX_RANGE_LENGTH // rows:
            raise BoError("Resource-Error", operands)
        values = []
        for row in range(rows):
            for column in range(columns):
                total = 0.0
                for index in range(inner):
                    total += left_data[row * inner + index] * right_data[index * columns + column]
                    if not math.isfinite(total):
                        raise BoError("Evaluation-Error", operands)
                values.append(norm(total))
        return [[values, [rows, columns]]]

    @staticmethod
    def _broadcast_shape(left_shape, right_shape, operands):
        result = []
        for axis in range(max(len(left_shape), len(right_shape))):
            left_dimension = left_shape[-1 - axis] if axis < len(left_shape) else 1
            right_dimension = right_shape[-1 - axis] if axis < len(right_shape) else 1
            if left_dimension == right_dimension:
                result.append(left_dimension)
            elif left_dimension == 1:
                result.append(right_dimension)
            elif right_dimension == 1:
                result.append(left_dimension)
            else:
                raise BoError("Shape-Error", operands)
        return tuple(reversed(result))

    @staticmethod
    def _broadcast_element(data, shape, output_shape, coordinates):
        offset = 0
        start = len(output_shape) - len(shape)
        for axis, dimension in enumerate(shape):
            coordinate = 0 if dimension == 1 else coordinates[start + axis]
            offset = offset * dimension + coordinate
        return data[offset]

    def _word_operation(self, word):
        """The binary primitive a word currently runs on a pair of numbers, or None.

        The word must be a default-stack wrapper `(() ADD)`, `(() SUB)`, ... of an unmodified
        primitive; any other word runs through the machine, with the same observable result."""
        stack = self.stacks.get(canon([word]))
        if not stack or type(stack[-1]) is not list:
            return None
        definition = stack[-1]
        if (len(definition) != 2 or definition[0] != [] or type(definition[1]) is not Word):
            return None
        operation = _BROADCAST_OPERATIONS.get(definition[1].name)
        target = canon([definition[1]])
        if operation is None or self.stacks.get(target) or target not in self.word_natives:
            return None
        return operation

    def _word_call(self, program, marker, saved, x, y):
        """Run the operation word on the selected stack with the pair on top; it must leave
        exactly one number. The stack is restored when it fails."""
        data = self.data
        base = len(saved)
        data.extend((x, y))
        self.run(program)
        if len(data) > base and data[-1] is marker:
            error = data[-2]
            data[:] = saved
            raise BoRethrow(error)
        if len(data) != base + 1 or not is_plain_number(data[-1]):
            kind = "Type-Error" if len(data) == base + 1 else "Stack-Error"
            data[:] = saved
            raise BoError(kind, [x, y])
        return data.pop()

    def n_broadcast(self, left, right, unit):
        operands = [left, right, unit]
        if not (isinstance(unit, list) and len(unit) == 1 and type(unit[0]) is Word):
            raise BoError("Type-Error", operands)
        word = unit[0]
        left_data, left_shape = ((None, ()) if is_plain_number(left)
                                 else self._tensor(left, operands))
        right_data, right_shape = ((None, ()) if is_plain_number(right)
                                   else self._tensor(right, operands))
        if any(is_plain_number(value) and not math.isfinite(value) for value in (left, right)):
            raise BoError("Domain-Error", operands)

        shape = self._broadcast_shape(left_shape, right_shape, operands)
        size = 1
        for dimension in shape:
            if dimension and size > MAX_RANGE_LENGTH // dimension:
                raise BoError("Resource-Error", operands)
            size *= dimension

        marker = object()
        program = [[word], [marker], [], Word("CATCH")]
        saved = list(self.data)
        operation = self._word_operation(word)
        pairs = []
        for index in range(size):
            coordinates = [0] * len(shape)
            remaining = index
            for axis in range(len(shape) - 1, -1, -1):
                coordinates[axis] = remaining % shape[axis]
                remaining //= shape[axis]
            pairs.append((
                left if left_data is None else self._broadcast_element(
                    left_data, left_shape, shape, coordinates),
                right if right_data is None else self._broadcast_element(
                    right_data, right_shape, shape, coordinates)))
        values = None
        if operation is not None:
            try:
                values = [self._arith(x, y, operation)[0] for x, y in pairs]
            except BoError:
                values = None
        if values is None:
            try:
                values = [self._word_call(program, marker, saved, x, y) for x, y in pairs]
            except BoRethrow:
                self.data.extend(operands)
                raise
        if left_data is None and right_data is None:
            return [values[0]]
        return [[values, list(shape)]]

    @staticmethod
    def _range(start, step, end, operands):
        if not all(is_plain_number(value) for value in operands):
            raise BoError("Type-Error", operands)
        try:
            start, step, end = map(float, (start, step, end))
        except OverflowError:
            raise BoError("Domain-Error", operands)
        if not all(map(math.isfinite, (start, step, end))):
            raise BoError("Domain-Error", operands)
        if step == 0 or (step > 0 and start > end) or (step < 0 and start < end):
            return []

        span = end - start if step > 0 else start - end
        quotient = span / abs(step)
        if not math.isfinite(quotient):
            raise BoError("Resource-Error", operands)

        nearest = math.floor(quotient + 0.5)
        tolerance = 4 * sys.float_info.epsilon * max(1.0, abs(quotient))
        snap_endpoint = abs(quotient - nearest) <= tolerance
        intervals = nearest if snap_endpoint else math.floor(quotient)
        count = intervals + 1
        if count > MAX_RANGE_LENGTH:
            raise BoError("Resource-Error", operands)

        values = []
        for index in range(count):
            value = start + index * step
            if not math.isfinite(value):
                raise BoError("Evaluation-Error", operands)
            if index == intervals and snap_endpoint:
                value = end
            elif ((step > 0 and value > end) or (step < 0 and value < end)):
                raise BoError("Evaluation-Error", operands)
            values.append(norm(value))
        return values

    # --------------------------------------------------------------------- I/O

    def _stream(self, handle):
        if not is_int(handle):
            raise BoError("Type-Error", [handle])
        standard = {0: sys.stdin, 1: sys.stdout, 2: sys.stderr}
        if handle in standard:
            return standard[handle]
        if handle not in self.streams:
            raise BoError("Existence-Error", [handle])
        return self.streams[handle]

    def n_open(self, path, mode):
        path, mode = to_str(path), to_str(mode)
        if mode not in ("r", "w", "a", "rb", "wb", "ab"):
            raise BoError("Domain-Error", [from_str(mode)])
        try:
            stream = open(path, mode, **({} if "b" in mode else {"encoding": "utf-8"}))
        except OSError as error:
            raise BoError("Io-Error", [from_str(str(error))])
        handle = self.next_stream
        self.next_stream += 1
        self.streams[handle] = stream
        return [handle]

    def n_close(self, handle):
        stream = self._stream(handle)
        if handle in (0, 1, 2):
            raise BoError("Permission-Error", [handle])
        del self.streams[handle]
        try:
            stream.close()
        except OSError as error:
            raise BoError("Io-Error", [from_str(str(error))])

    def n_read(self, handle):
        stream = self._stream(handle)
        try:
            char = stream.read(1)
        except OSError as error:
            raise BoError("Io-Error", [from_str(str(error))])
        if not char:
            return [-1]
        return [ord(char) if isinstance(stream, io.TextIOBase) else char[0]]

    def n_write(self, code, handle):
        stream = self._stream(handle)
        if not is_int(code):
            raise BoError("Type-Error", [code])
        try:
            if isinstance(stream, io.TextIOBase):
                stream.write(chr(code))
            else:
                stream.write(bytes([code]))
            if handle in (1, 2):
                stream.flush()
        except OSError as error:
            raise BoError("Io-Error", [from_str(str(error))])
        except (ValueError, OverflowError):
            raise BoError("Domain-Error", [code])

    def n_include(self, path):
        name = self._include_path(to_str(path))
        if self._resolved(name) in self._loading:
            raise BoError("Cycle-Error", [from_str(name)])
        self._remember_include_root(name)
        try:
            text = Path(name).read_text(encoding="utf-8")
        except OSError as error:
            raise BoError("Io-Error", [from_str(str(error))])
        try:
            forms = self._lower_file(text, name)
        except LoweringError as error:
            raise BoError("Syntax-Error", [from_str(error.msg), error.line])
        resolved = self._resolved(name)
        self.included.add(resolved)
        file_id = self._file_id(name)
        outer_file = self.cur_file
        self._wipe_file(file_id)
        self.cur_file = file_id
        self._loading.append(resolved)
        try:
            self._run_forms(forms, name)
        except BaseException:
            # a file that did not finish loading is not included, so `include` tries it again
            self.included.discard(resolved)
            self._finish_load(file_id, True)
            raise
        else:
            self._finish_load(file_id, False)
        finally:
            self._loading.pop()
            self.cur_file = outer_file

    def n_parse(self, text):
        try:
            forms = self._lower(to_str(text))
        except LoweringError as error:
            raise BoError("Syntax-Error", [from_str(error.msg), error.line])
        return [[item for _, items in forms for item in items]]

    def _include_path(self, name):
        path = Path(name)
        if not path.is_absolute():
            candidates = []
            if self.source != "stdin":
                candidates.append(Path(self.source).parent / path)
            candidates.extend(parent / path for parent in reversed(self._include_roots))
            candidates.append(path)
            candidates.append(self.home / path)
            for candidate in candidates:
                if candidate.exists():
                    path = candidate
                    break
        return str(path)

    def _remember_include_root(self, path):
        parent = Path(path).resolve().parent
        if parent not in self._include_roots:
            self._include_roots.append(parent)

    @staticmethod
    def _resolved(name):
        return str(Path(name).resolve())

    def n_included(self, path):
        return [1 if self._resolved(self._include_path(to_str(path))) in self.included else 0]

    def n_catch(self, attempt, handler):
        for block in (attempt, handler):
            if not isinstance(block, list):
                raise BoError("Type-Error", [block])
        self._trim()
        self.control.append(_CatchFrame(handler))
        self.control.append(self._frame(attempt))

    def n_call(self, setup, body, catcher, cleanup):
        programs = (setup, body, catcher, cleanup)
        for program in programs:
            if not isinstance(program, list):
                raise BoError("Type-Error", [program])
        self._trim()
        self.control.append(_CallFrame(programs))
        self._enter(setup)

    def n_rethrow(self, error):
        def text(value):
            return (isinstance(value, list) and all(
                is_int(c) and 0 <= c <= 0x10ffff and not 0xd800 <= c <= 0xdfff
                for c in value))

        def word_unit(value):
            try:
                word_to_text(value)
            except BoError:
                return False
            return True

        if (not isinstance(error, list) or len(error) != 5
                or not word_unit(error[0]) or not word_unit(error[1])
                or not isinstance(error[2], list) or not text(error[3])
                or not is_int(error[4]) or abs(error[4]) > 2**53):
            raise BoError("Type-Error", [error])
        raise BoRethrow(error)

    def n_throw(self, data, kind):
        if not isinstance(data, list):
            raise BoError("Type-Error", [data])
        word_to_text(kind)
        raise BoError(kind[0].name, data, "THROW")

    def n_exit(self, status):
        if not is_int(status):
            raise BoError("Type-Error", [status])
        if not 0 <= status <= 255:
            raise BoError("Domain-Error", [status])
        raise SystemExit(status)

    def n_abort(self):
        raise AbortSignal

    def n_breakpoint(self):
        """Nothing pauses a program here (the prompt of the C runtime does). A host may want to show
        where the program is, and then carries on."""
        if self.breakpoint_hook is not None:
            self.breakpoint_hook(self)

    def n_resume(self):
        """STEP, NEXT, CONTINUE and STOP resume a paused program, and none is ever paused here."""
        raise BoError("Debug-Error")

    def program_frames(self):
        """The programs being run, innermost first, as (program, index of the next item, calling word)."""
        for control in (self.control, *reversed(self._suspended)):
            for frame in reversed(control):
                if type(frame) is list:
                    yield frame[2], min(frame[1], len(frame[2])), frame[3]

    def n_backtrace(self):
        return [[[[name] if name is not None else [], program, index]
                 for program, index, name in self.program_frames()]]


def _divide(a, b):
    if is_int(a) and is_int(b) and a % b == 0:
        return a // b
    return a / b


_BROADCAST_OPERATIONS = {
    "ADD": lambda x, y: x + y,
    "SUB": lambda x, y: x - y,
    "MUL": lambda x, y: x * y,
    "DIV": _divide,
    "IDIV": lambda x, y: x // y,
    "POW": math.pow,
}
