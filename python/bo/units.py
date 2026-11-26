"""Unit-based list operations."""

from .values import BoError


def unit_element(unit):
    """Return a unit's element without evaluating it."""
    if not isinstance(unit, list) or len(unit) != 1:
        raise BoError("Type-Error", [unit])
    return unit[0]


def cons_unit(lst, unit, right=False):
    if not isinstance(lst, list):
        raise BoError("Type-Error", [lst])
    element = unit_element(unit)
    return lst + [element] if right else [element] + lst


def uncons_unit(lst, right=False):
    if not isinstance(lst, list):
        raise BoError("Type-Error", [lst])
    if not lst:
        raise BoError("Stack-Error", [lst])
    return (lst[:-1], [lst[-1]]) if right else (lst[1:], [lst[0]])
