"""Op identities and the conversions between names and selectors."""

from .lower import valid_op_name
from .units import unit_element
from .values import BoError, Op, from_str, is_int, is_plain_number


def unit_type(unit):
    """Classify a unit's element: 0 number, 1 list, 2 op."""
    element = unit_element(unit)
    if is_plain_number(element):
        return 0
    if isinstance(element, list):
        return 1
    if isinstance(element, Op):
        return 2
    raise BoError("Type-Error", [unit])


def name_to_selector(text):
    """Convert character codes to a unit containing an op."""
    if not isinstance(text, list) or not all(is_int(c) for c in text):
        raise BoError("Type-Error", [text])
    if any(c < 0 or c > 0x10FFFF for c in text):
        raise BoError("Representation-Error", [text])
    name = "".join(map(chr, text))
    if not valid_op_name(name):
        raise BoError("Representation-Error", [text])
    return [Op(name)]


def selector_to_name(selector):
    """Convert a unit containing an op to its character codes."""
    op = unit_element(selector)
    if not isinstance(op, Op):
        raise BoError("Type-Error", [selector])
    if not isinstance(op.name, str) or not valid_op_name(op.name):
        raise BoError("Representation-Error", [selector])
    return from_str(op.name)
