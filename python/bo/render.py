"""Host-side rendering, used only for error messages (ps and emit are in the standard library)."""

from .values import Word


def render(value):
    if isinstance(value, Word):
        return value.name
    if isinstance(value, list):
        return "(" + " ".join(render(element) for element in value) + ")"
    return repr(value)
