#!/usr/bin/env python3
"""Generate Bo's mechanical kernel adapter libraries."""

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
C_MACHINE = ROOT / "c" / "machine.c"
CORE_LIBRARY = ROOT / "include" / "core.bo"
PRIMITIVE_DOCS = ROOT / "include" / "primitives.json"

# These primitives have no plain default-stack wrapper: `PUSH`, `POP`, `TOP`, `EXISTS` and `LOCKED`
# transfer to or inspect a selected stack rather than applying an operation to it (`() EXISTS` and
# `() LOCKED` could only give the same answer),
# and `DELETE` could only ever fail on the default stack.
NO_DEFAULT_ADAPTERS = frozenset({
    "PUSH",
    "POP",
    "TOP",
    "EXISTS",
    "LOCKED",
    "DELETE",
})
# Primitives whose default-stack wrapper is a symbol instead of the lowercase spelling:
# a symbol cannot be confused with the uppercase primitive, so no spelled twin is defined.
SYMBOL_ADAPTERS = {
    "ADD": "+",
    "SUB": "-",
    "MUL": "*",
    "DIV": "/",
    "IDIV": "//",
    "POW": "^",
    "EQUAL": "=",
    "RANGE": "::",
    "BROADCAST": ".",
    "REDUCE": "..",
    "FETCH": "->",
    "STORE": "<-",
    "BREAKPOINT": "@",
}
# Documented derived ops that core.bo defines itself next to the wrappers of their group:
# `require` because every library module needs it before anything else can be loaded,
# `eval` because it is `parse` followed by `apply`, and `:` because it is `::` with a unit step.
CORE_DERIVED = (
    {
        "name": "require",
        "group": "Source",
        "type": "derived",
        "effect": "P --",
        "description": "Load source file `P` unless it was already loaded; `include` loads it again. A file whose load ended in an error does not count as loaded.",
        "definition": "((0 pick included) (drop) (() INCLUDE) ifte)",
    },
    {
        "name": "eval",
        "group": "Source",
        "type": "derived",
        "effect": "T -- ...",
        "description": "Read the source code in string `T` and run it; a source error raises `Syntax-Error` before anything runs.",
        "definition": "(parse apply)",
    },
    {
        "name": ":",
        "group": "Math",
        "type": "derived",
        "effect": "a b -- L",
        "description": "The inclusive list from `a` to `b` in steps of 1, like `a 1 b ::`.",
        "definition": "(1 1 () ROLL () RANGE)",
    },
)
ADAPTER_EFFECTS = {
    "CLEAR": "--",
    "DEPTH": "-- n",
    "LAMBDA": "P --",
    "LOCK": "--",
    "LOOP": "C B --",
    "REC": "--",
    "SNAPSHOT": "-- L",
    "UNLOCK": "--",
}
ADAPTER_DESCRIPTIONS = {
    "SNAPSHOT": "Copy the contents as a list.",
    "DEPTH": "Return the number of values.",
    "ABORT": "Abandon the current top-level run.",
    "UNIT": "Wrap the top value in a one-element list.",
    "LAMBDA": "Run the program `P`; inside it, `rec` runs `P` again (anonymous recursion).",
    "REC": "Run again the program of the innermost running `lambda`.",
    "LOOP": "Repeat: execute `C`, and if its result is positive execute `B` and start again.",
}
SELECTED_EFFECT = re.compile(r"D: \([^)]*\), S: \((.*)\)$")
PRIMITIVE_EFFECT = re.compile(r"D: \([^)]*\bs\b[^)]*\), S: \(.+\)$")


def native_names():
    source = C_MACHINE.read_text(encoding="utf-8")
    tables = re.search(
        r"static const Native NATIVES\[\] = \{(.*?)\};\s*"
        r"static const Native OP_NATIVES\[\] = \{(.*?)\};",
        source,
        re.DOTALL,
    )
    if tables is None:
        raise ValueError(f"cannot find native tables in {C_MACHINE}")
    names = list(dict.fromkeys(re.findall(r'\{"([^"]+)"', tables.group(1) + tables.group(2))))
    unknown = NO_DEFAULT_ADAPTERS.difference(names)
    if unknown:
        raise ValueError(f"unknown default-adapter exclusions: {', '.join(sorted(unknown))}")
    return names


def primitive_docs():
    data = json.loads(PRIMITIVE_DOCS.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{PRIMITIVE_DOCS} must contain a JSON object")
    docs = data.get("primitives")
    if not isinstance(docs, list):
        raise ValueError(f"{PRIMITIVE_DOCS} must contain a 'primitives' list")
    names = set()
    for doc in docs:
        if not isinstance(doc, dict) or doc.get("type") != "primitive":
            raise ValueError(f"all entries in {PRIMITIVE_DOCS} must have type 'primitive'")
        name, group, effect, stack, description = (
            doc.get("name"), doc.get("group"), doc.get("effect"), doc.get("stack"),
            doc.get("description"))
        if not all(isinstance(value, str) and value
                   for value in (name, group, effect, stack, description)):
            raise ValueError(
                "each primitive doc needs a non-empty name, group, effect, stack, and description")
        if stack not in {
            "`D` (default)",
            "`S` (named `s`)",
            "`D`<->`S` (cross-stack)",
        }:
            raise ValueError(f"invalid stack scope for primitive {name}: {stack}")
        if not PRIMITIVE_EFFECT.fullmatch(effect):
            raise ValueError(f"primitive effect must include selector s and selected stack: {name}")
        if name in names:
            raise ValueError(f"duplicate primitive documentation entry: {name}")
        names.add(name)
    return docs


def adapter_name(primitive):
    if primitive in SYMBOL_ADAPTERS:
        return SYMBOL_ADAPTERS[primitive]
    qualifier, dot, action = primitive.rpartition(".")
    if not action.isupper():
        raise ValueError(f"primitive name must be uppercase: {primitive}")
    return f"{qualifier}{dot}{action.lower()}"


def default_adapter_doc(primitive):
    name = primitive["name"]
    match = SELECTED_EFFECT.fullmatch(primitive["effect"])
    if match is None:
        raise ValueError(f"invalid two-stack effect for {name}: {primitive['effect']}")
    description = ADAPTER_DESCRIPTIONS.get(name, primitive["description"])
    description = description.removeprefix("On `S`, ")
    if description:
        description = description[0].upper() + description[1:]
    return {
        "name": adapter_name(name),
        "group": primitive["group"],
        "primitive": name,
        "type": "primitive adapter",
        "effect": ADAPTER_EFFECTS.get(name, " ".join(match.group(1).split())),
        "description": description,
    }


def core_source(docs):
    adapters = [
        default_adapter_doc(doc)
        for doc in docs if doc["name"] not in NO_DEFAULT_ADAPTERS
    ]
    if len({doc["name"] for doc in adapters}) != len(adapters):
        raise ValueError("primitive names produce duplicate default-stack adapter names")
    unknown = set(SYMBOL_ADAPTERS).difference(doc["name"] for doc in docs)
    if unknown:
        raise ValueError(f"symbols for unknown primitives: {', '.join(sorted(unknown))}")
    groups = {}
    for doc in adapters + list(CORE_DERIVED):
        groups.setdefault(doc["group"], []).append(doc)
    lines = [
        "; Default-stack ops for the kernel primitives. Generated by",
        "; tools/generate_adapters.py from include/primitives.json: do not edit by hand.",
        "",
    ]
    for group, entries in sorted(groups.items()):
        lines.extend((f";----- {group}", ""))
        for doc in sorted(entries, key=lambda entry: entry["name"]):
            effect = " ".join(doc["effect"].split())
            description = " ".join(doc["description"].split())
            lines.append(f";{doc['name']} ( {effect} ) {description}")
            definition = doc.get("definition") or f"(() {doc['primitive']})"
            lines.append(f"{definition} ({doc['name']}) PUSH")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def generated_files():
    names = native_names()
    docs = primitive_docs()
    documented = {doc["name"] for doc in docs}
    if documented != set(names):
        missing = sorted(set(names) - documented)
        stale = sorted(documented - set(names))
        details = []
        if missing:
            details.append(f"missing docs: {', '.join(missing)}")
        if stale:
            details.append(f"not registered: {', '.join(stale)}")
        raise ValueError(f"{PRIMITIVE_DOCS} does not match the C registry ({'; '.join(details)})")
    if not NO_DEFAULT_ADAPTERS.issubset(documented):
        raise ValueError("default-adapter exclusions must be documented primitives")
    return {
        CORE_LIBRARY: core_source(docs),
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="fail if the committed adapters are not generated")
    args = parser.parse_args(argv)
    generated = generated_files()
    stale = []
    for path, content in generated.items():
        current = path.read_text(encoding="utf-8")
        if current != content:
            stale.append(path)
    if args.check:
        if stale:
            paths = ", ".join(str(path.relative_to(ROOT)) for path in stale)
            print(f"{paths} are stale; run tools/generate_adapters.py", file=sys.stderr)
            return 1
        return 0
    for path, content in generated.items():
        path.write_text(content, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
