"""Generate reusable straight-line fragments from quotation element shapes."""

from python.bo.lower import lower_word_forms
from python.bo.values import Word


def generate(sources):
    shapes = set()

    def visit(items):
        if items:
            shapes.add("".join("w" if isinstance(item, Word) else "v" for item in items))
        for item in items:
            if isinstance(item, list):
                visit(item)

    for source in sources:
        for _, forms in lower_word_forms(source):
            for item in forms:
                if isinstance(item, list):
                    visit(item)
    if not shapes:
        raise ValueError("at least one non-empty quotation is required")
    shapes = sorted(shapes)
    lines = ['#include "bo.h"']
    for number, shape in enumerate(shapes):
        lines.extend((f"static int fragment_{number}(Machine *m, size_t base, size_t pc) {{",
                      "    int status;", "    switch (pc) {"))
        for i in range(len(shape)):
            lines.append(f"    case {i}: goto L{i};")
        lines.extend(('    default: fputs("invalid fragment resume\\n", stderr); abort();', "    }"))
        for i, kind in enumerate(shape):
            helper = "linked_fragment_word" if kind == "w" else "linked_fragment_literal"
            lines.extend((f"L{i}:",
                          f"    status = {helper}(m, base + {i});",
                          "    if (status) return status;"))
        lines.extend(("    return 0;", "}"))
    lines.append("const LinkedFragment linked_fragments[] = {")
    for number, shape in enumerate(shapes):
        lines.append(f'    {{"{shape}", {len(shape)}, fragment_{number}}},')
    lines.extend(("};", f"const size_t linked_fragment_count = {len(shapes)};"))
    return "\n".join(lines) + "\n"
