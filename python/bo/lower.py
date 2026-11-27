"""Lowering: source text -> numbers, lists and ops (README section 3)."""

import math
import re

from .values import Op, from_str, norm

INT_RE = re.compile(r"[+-]?[0-9]+\Z")
FLOAT_RE = re.compile(r"[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
ESCAPES = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "s": " "}
DELIMITERS = set('();"')
PRIVATE_PREFIX = "__"


class LoweringError(Exception):
    def __init__(self, msg, line, incomplete=False):
        super().__init__(msg)
        self.msg = msg
        self.line = line
        self.incomplete = incomplete


def parse_number(token):
    """Return the number denoted by token, None if it is not a number.

    Raises ValueError for a numeric token that cannot be represented.
    """
    if INT_RE.match(token) or FLOAT_RE.match(token):
        value = float(token)
        if not math.isfinite(value):
            raise ValueError("number out of range")
        return norm(value)
    return None


def tokenize(text, first_line=1):
    tokens = []
    i, n, line = 0, len(text), first_line
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
        elif c == ";":
            while i < n and text[i] != "\n":
                i += 1
        elif c.isspace():
            i += 1
        elif c in "()":
            tokens.append((c, c, line))
            i += 1
        elif c == '"':
            start = line
            i += 1
            buf = []
            while True:
                if i >= n:
                    raise LoweringError("unterminated string", start, True)
                ch = text[i]
                if ch == '"':
                    i += 1
                    break
                if ch == "\\":
                    if i + 1 >= n:
                        raise LoweringError("unterminated string", start, True)
                    esc = text[i + 1]
                    if esc not in ESCAPES:
                        raise LoweringError(f"bad escape \\{esc}", line)
                    buf.append(ESCAPES[esc])
                    i += 2
                    continue
                if ch == "\n":
                    line += 1
                buf.append(ch)
                i += 1
            tokens.append(("str", "".join(buf), start))
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in DELIMITERS:
                j += 1
            tokens.append(("atom", text[i:j], line))
            i = j
    return tokens


def valid_op_name(name):
    """Whether a name can be written as a single non-numeric source token."""
    if not name or any(ord(c) == 0 or 0xD800 <= ord(c) <= 0xDFFF for c in name):
        return False
    try:
        tokens = tokenize(name)
        if len(tokens) != 1 or tokens[0][:2] != ("atom", name):
            return False
        return parse_number(name) is None
    except (LoweringError, ValueError):
        return False


def _lower_op_atom(token, line, owner=0):
    try:
        number = parse_number(token)
    except ValueError:
        raise LoweringError(f"number out of range: {token}", line)
    if number is not None:
        return [number]
    if not valid_op_name(token):
        raise LoweringError("invalid op name", line)
    return [Op(token, owner if token.startswith(PRIVATE_PREFIX) else 0)]


def lower_op_forms(text, first_line=1, owner=0):
    """Lower source to numbers, lists and indivisible ops.

    With a nonzero `owner` (the id of a source file) the ops that start with `__` are private
    to that file.
    """
    return _lower_forms(text, first_line, lambda token, line: _lower_op_atom(token, line, owner))


def _lower_forms(text, first_line, lower_atom):
    forms = []
    stack = []

    def emit(items, line):
        if stack:
            stack[-1][0].extend(items)
        else:
            forms.append((line, items))

    for kind, value, line in tokenize(text, first_line):
        if kind == "(":
            stack.append(([], line))
        elif kind == ")":
            if not stack:
                raise LoweringError("unmatched ')'", line)
            items, start = stack.pop()
            emit([items], start)
        elif kind == "str":
            emit([from_str(value)], line)
        else:
            emit(lower_atom(value, line), line)
    if stack:
        raise LoweringError("unmatched '('", stack[0][1], True)
    return forms
