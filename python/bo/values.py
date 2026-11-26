"""Bo values: numbers, lists, and words."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Word:
    """A word's identity is its case-sensitive name, not its current definition.

    A private word (written `__name` in a source file) also carries the id of the file that owns
    it, so it never equals, and never names the same stack as, a word spelled alike elsewhere.
    """

    name: str
    owner: int = 0


class BoError(Exception):
    """Raised by primitives; the machine turns it into an error list (README section 5)."""

    def __init__(self, kind, data=None, where=None):
        super().__init__(kind)
        self.kind = kind
        self.data = data if data is not None else []
        self.where = where


class BoRethrow(Exception):
    """Propagate an existing error value without creating another occurrence."""

    def __init__(self, error):
        self.error = error


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_number(v):
    return is_int(v) or isinstance(v, float)


def is_plain_number(v):
    return is_number(v)


LIMIT = 2 ** 53


def norm(x):
    """Canonical form of a number: integral values up to 2**53 are ints, the rest are floats.

    This mimics a double-only machine (no integer type, no bignums) while letting
    the host use ints for indices and code points.
    """
    if type(x) is float:
        if x.is_integer() and abs(x) <= LIMIT:
            return int(x)
    elif abs(x) > LIMIT:
        return float(x)
    return x


def canon(v):
    """Hashable canonical form: structural identity (numbers are compared by value)."""
    if isinstance(v, list):
        return ("l", tuple(canon(x) for x in v))
    if isinstance(v, Word):
        return ("w", v.name, v.owner) if v.owner else ("w", v.name)
    return ("n", v)


def from_str(s):
    return [ord(c) for c in s]


def to_str(v):
    if not isinstance(v, list) or not all(is_int(c) for c in v):
        raise BoError("Type-Error", [v])
    try:
        return "".join(map(chr, v))
    except (ValueError, OverflowError):
        raise BoError("Domain-Error", [v])
