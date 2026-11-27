#!/usr/bin/env python3
"""Generate the Bo primitive and standard-library references."""

import re
import sys
from pathlib import Path

from generate_adapters import (
    CORE_DERIVED,
    NO_DEFAULT_ADAPTERS,
    PRIMITIVE_DOCS,
    default_adapter_doc,
    native_names,
    primitive_docs,
)

ROOT = Path(__file__).resolve().parent.parent
LIBRARY_TEMPLATE = ROOT / "doc" / "library.md.in"
PRIMITIVES_TEMPLATE = ROOT / "doc" / "primitives.md.in"
LIBRARY_OUT = ROOT / "doc" / "library.md"
PRIMITIVES_OUT = ROOT / "doc" / "primitives.md"
EXCLUDED_DERIVED_SOURCES = {"core.bo", "std.bo"}
DERIVED_SOURCES = tuple(
    path for path in sorted((ROOT / "include").glob("*.bo"))
    if path.name not in EXCLUDED_DERIVED_SOURCES
)
ENTRY = re.compile(r"^(\S+) \(((?:[^()]|\(\))*)\) (.*)$")
LIBRARY_SLOT = "{{GENERATED_LIBRARY_TABLES}}"
PRIMITIVES_SLOT = "{{GENERATED_PRIMITIVE_TABLES}}"
PRIMITIVE_STACKS = {
    "`D` (default)",
    "`S` (named `s`)",
    "`D`<->`S` (cross-stack)",
}


def md(text):
    return text.replace("|", r"\|")


def parse_derived(path):
    entries = []
    group = path.stem.capitalize()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith(";"):
            continue
        match = ENTRY.match(line[1:].lstrip())
        if match and not match.group(1).startswith("__"):
            name, effect, description = match.groups()
            entries.append({
                "name": name,
                "group": group,
                "type": "derived",
                "effect": " ".join(effect.split()),
                "description": " ".join(description.split()),
            })
    return entries


def inventory():
    docs = primitive_docs()
    registered = set(native_names())
    documented = {doc["name"] for doc in docs}
    if documented != registered:
        raise ValueError(f"{PRIMITIVE_DOCS} does not match the C primitive registry")

    primitives = docs
    if any(not entry["effect"].startswith("D: (") or ", S: (" not in entry["effect"]
           for entry in primitives):
        raise ValueError("primitive effects must describe both default and selected stacks")
    adapters = [
        default_adapter_doc(doc)
        for doc in docs if doc["name"] not in NO_DEFAULT_ADAPTERS
    ]
    derived = [
        entry for path in DERIVED_SOURCES for entry in parse_derived(path)
    ]
    core_derived = [
        {key: op[key] for key in ("name", "group", "type", "effect", "description")}
        for op in CORE_DERIVED
    ]
    library = adapters + core_derived + derived
    for entries, label in ((primitives, "primitive"), (library, "library")):
        names = [entry["name"] for entry in entries]
        if len(set(names)) != len(names):
            duplicates = sorted(name for name in set(names) if names.count(name) > 1)
            raise ValueError(f"duplicate {label} documentation names: {', '.join(duplicates)}")
    return primitives, library


def render_tables(entries, heading_level=3):
    include_stack = bool(entries) and all(
        entry["type"] == "primitive" for entry in entries)
    groups = {}
    for entry in entries:
        groups.setdefault(entry["group"], []).append(entry)
    output = []
    for name, group in sorted(groups.items()):
        output.extend((f"{'#' * heading_level} {name}", ""))
        if include_stack:
            output.extend((
                "| Name | Type | Effect | Stack | Description |",
                "|---|---|---|---|---|",
            ))
        else:
            output.extend((
                "| Name | Type | Effect | Description |",
                "|---|---|---|---|",
            ))
        for entry in sorted(group, key=lambda item: item["name"]):
            effect = md(entry["effect"])
            if entry["type"] != "primitive":
                effect = f"( {effect} )"
            row = (f"| `{md(entry['name'])}` | {entry['type']} | `{effect}` |")
            if include_stack:
                row += f" {md(entry['stack'])} |"
            output.append(f"{row} {md(entry['description'])} |")
        output.append("")
    return "\n".join(output).rstrip()


def render():
    primitives, library = inventory()
    results = {}
    for template, output, slot, entries, heading_level in (
        (LIBRARY_TEMPLATE, LIBRARY_OUT, LIBRARY_SLOT, library, 3),
        (PRIMITIVES_TEMPLATE, PRIMITIVES_OUT, PRIMITIVES_SLOT, primitives, 4),
    ):
        content = template.read_text(encoding="utf-8")
        if content.count(slot) != 1:
            raise ValueError(f"{template} must contain exactly one {slot} slot")
        results[output] = content.replace(
            slot, render_tables(entries, heading_level=heading_level))
    return results


def main(argv):
    try:
        outputs = render()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Cannot generate documentation: {error}", file=sys.stderr)
        return 1
    if "--check" in argv:
        stale = [path for path, content in outputs.items()
                 if not path.exists() or path.read_text(encoding="utf-8") != content]
        if stale:
            names = ", ".join(str(path.relative_to(ROOT)) for path in stale)
            print(f"{names} are stale: run python3 tools/bodoc.py")
            return 1
        return 0
    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8")
    print("wrote doc/library.md and doc/primitives.md")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
