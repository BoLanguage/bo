"""Word identities and unit-based conversions."""

from .lower import valid_word_name
from .units import unit_element
from .values import BoError, Word, from_str, is_int, is_plain_number


def unit_type(unit):
    """Classify a unit's element: 0 number, 1 list, 2 word."""
    element = unit_element(unit)
    if is_plain_number(element):
        return 0
    if isinstance(element, list):
        return 1
    if isinstance(element, Word):
        return 2
    raise BoError("Type-Error", [unit])


def text_to_word(text):
    """Convert character codes to a unit containing a word."""
    if not isinstance(text, list) or not all(is_int(c) for c in text):
        raise BoError("Type-Error", [text])
    if any(c < 0 or c > 0x10FFFF for c in text):
        raise BoError("Representation-Error", [text])
    name = "".join(map(chr, text))
    if not valid_word_name(name):
        raise BoError("Representation-Error", [text])
    return [Word(name)]


def word_to_text(unit):
    """Convert a unit containing a word to its character codes."""
    word = unit_element(unit)
    if not isinstance(word, Word):
        raise BoError("Type-Error", [unit])
    if not isinstance(word.name, str) or not valid_word_name(word.name):
        raise BoError("Representation-Error", [unit])
    return from_str(word.name)
