"""Translate a file of literal Bo word definitions to experimental x86-64 assembly."""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from python.bo.lower import LoweringError, lower_word_forms
from python.bo.values import Word


def c_bytes(text):
    return "{" + ",".join(str(byte) for byte in text.encode("utf-8")) + ",0}"


def translate(source):
    forms = [items[0] for _, items in lower_word_forms(source)]
    if not forms or len(forms) % 3:
        raise ValueError("expected one or more (quotation) (WORD) PUSH definitions")
    roots = []
    seen = set()
    blocks = []

    def add_block(items, parent=None, element=None):
        index = len(blocks)
        blocks.append((items, parent, element))
        for i, item in enumerate(items):
            if isinstance(item, list):
                add_block(item, index, i)
            elif not isinstance(item, (int, float, Word)):
                raise ValueError(f"unsupported value at block {index}, element {i}")
        return index

    for pos in range(0, len(forms), 3):
        body, name, push = forms[pos:pos + 3]
        if (not isinstance(body, list) or not isinstance(name, list) or len(name) != 1
                or not isinstance(name[0], Word) or not isinstance(push, Word) or push.name != "PUSH"):
            raise ValueError(f"expected (quotation) (WORD) PUSH at definition {pos // 3 + 1}")
        if name[0].name in seen:
            raise ValueError(f"duplicate definition: {name[0].name}")
        seen.add(name[0].name)
        roots.append((add_block(body), name[0].name))

    asm = [".text"]
    for index, (items, _, _) in enumerate(blocks):
        asm.extend((f".globl aot_block_{index}", f".type aot_block_{index}, @function",
                    f"aot_block_{index}:", "    pushq %rbx", "    pushq %r12",
                    "    subq $8, %rsp", "    movq %rdi, %rbx", "    movq %rsi, %r12"))
        for i in range(len(items) + 1):
            asm.extend((f"    cmpq ${i}, %rdx", f"    je .L{index}_{i}"))
        asm.append("    ud2")
        for i, item in enumerate(items):
            helper = "aot_generated_call" if isinstance(item, Word) else "aot_generated_push"
            asm.extend((f".L{index}_{i}:", "    movq %rbx, %rdi", "    movq %r12, %rsi",
                        f"    movq ${i}, %rdx"))
            if isinstance(item, Word):
                asm.append(f"    movq ${i + 1}, %rcx")
            asm.append(f"    call {helper}")
            if isinstance(item, Word):
                asm.extend(("    testl %eax, %eax", f"    jne .L{index}_return"))
        asm.extend((f".L{index}_{len(items)}:", "    xorl %eax, %eax", f".L{index}_return:",
                    "    addq $8, %rsp", "    popq %r12", "    popq %rbx", "    ret"))
        asm.append(f".size aot_block_{index}, .-aot_block_{index}")
    asm.append('.section .note.GNU-stack,"",@progbits')

    c = ['#include "bo.h"', '#include <inttypes.h>',
         f"static const unsigned char definitions[] = {c_bytes(source)};"]
    for index in range(len(blocks)):
        c.append(f"extern int aot_block_{index}(Machine *, AotBlock *, size_t);")
    for index, name in roots:
        c.append(f"static const unsigned char name_{index}[] = {c_bytes(name)};")
    for index, (items, _, _) in enumerate(blocks):
        kinds = "".join("w" if isinstance(item, Word) else "l" if isinstance(item, list) else "n"
                        for item in items)
        c.append(f'static const char kinds_{index}[] = "{kinds}";')
    c.extend(('int main(int argc, char **argv) {',
              '    if (argc != 3 || (strcmp(argv[1], "aot") && strcmp(argv[1], "reference")',
              '                      && strcmp(argv[1], "native"))) {',
              '        fputs("usage: translated aot|reference|native BO-CODE\\n", stderr); return 2;',
              '    }',
              '    Machine m; machine_init(&m);',
              '    if (strcmp(argv[1], "native")) m.native = 0;',
              '    if (!include_file(&m, "include/core.bo") || !include_file(&m, "include/std.bo")) return 1;',
              '    if (!execute(&m, (const char *)definitions, sizeof definitions - 1, "aot-definitions", 1)) return 1;',
              '    if (!strcmp(argv[1], "aot")) {',
              f'        m.aot_count = {len(blocks)};',
              '        m.aot_blocks = calloc(m.aot_count, sizeof *m.aot_blocks);',
              '        if (!m.aot_blocks) { fputs("AOT: cannot allocate blocks\\n", stderr); return 2; }'))
    for index, name in roots:
        c.append(f'        if (!aot_bind_root(&m, {index}, (const char *)name_{index}, kinds_{index}, aot_block_{index})) '
                 f'{{ fputs("AOT: cannot bind root {index}\\n", stderr); return 2; }}')
    for index, (_, parent, element) in enumerate(blocks):
        if parent is not None:
            c.append(f'        if (!aot_bind_child(&m, {index}, {parent}, {element}, kinds_{index}, aot_block_{index})) '
                     f'{{ fputs("AOT: cannot bind child {index}\\n", stderr); return 2; }}')
    c.extend(('    }',
              '    if (getenv("BO_AOT_COLLECT")) gc_collect(&m);',
              '    m.aot_stats_enabled = getenv("BO_AOT_STATS") != NULL;',
              '    m.aot_gc_each = getenv("BO_AOT_GC_EACH") != NULL;',
              '    int ok = execute(&m, argv[2], strlen(argv[2]), "aot-workload", 1);',
              '    dump_stack(&m, stdout);',
              '    if (getenv("BO_AOT_STATS"))',
              '        fprintf(stderr, "BO_AOT_STATS operations=%" PRIu64 " direct=%" PRIu64'
              ' " depth_yields=%" PRIu64 " fallbacks=%" PRIu64 " max_depth=%zu"'
              ' " nested=%" PRIu64 "\\n",'
              ' m.aot_entries, m.aot_direct_calls, m.aot_depth_yields, m.aot_fallbacks,'
              ' m.aot_max_depth, m.aot_nested_entries);',
              '    if (m.aot_stats_enabled && getenv("BO_AOT_BLOCK_STATS"))',
              '        for (size_t i = 0; i < m.aot_count; i++)',
              '            fprintf(stderr, "BO_AOT_BLOCK index=%zu entries=%" PRIu64 "\\n", i, m.aot_blocks[i].entries);',
              '    return ok ? 0 : 1;',
              '}'))
    return "\n".join(asm) + "\n", "\n".join(c) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--assembly", required=True, type=Path)
    parser.add_argument("--harness", required=True, type=Path)
    args = parser.parse_args()
    try:
        asm, c = translate(args.source.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, LoweringError, ValueError) as error:
        parser.exit(1, f"AOT translation failed: {error}\n")
    args.assembly.write_text(asm, encoding="utf-8")
    args.harness.write_text(c, encoding="utf-8")


if __name__ == "__main__":
    main()
