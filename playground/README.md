# Playground (PG)

A web page for running Bo and watching the machine step by step. It is built around a prompt:
type some Bo, press Enter, and the stacks below update (Up and Down recall earlier entries, Esc
clears the prompt). The default stack is shown on a row of its own, top on the left and bottom on
the right (the other stacks list their top item first, too).

For longer programs, open the editor: the tab on the left edge of the window (`>`), or pick an
example or "Write your own". It slides in as a sidebar with a debugger (step by word, by line, or
by line plus user words), the word about to run and the nested programs being executed. Drag the
sidebar's edge to resize it (the width is remembered, double-click resets it). The prompt keeps
working while a program is paused, evaluating at the pause point, and a breakpoint (`@`) pauses a
program, from the editor or from the prompt itself (the prompt then turns yellow, and the words
`step`, `next`, `continue` and `stop` typed there act like the buttons); see
[debugging](../doc/debugging.md).

The `+` in the prompt opens a menu: upload a file as standard input; reset everything (always a fresh
machine, with the stacks, output, editor, standard input, picker and puzzle all cleared); fast run; show or hide
the editor; and share the editor's program as a link. It also offers **Start here**, a short, skippable guide that points with
an arrow at the prompt, the default stack, the editor, the picker and this menu (`onboarding.mjs` holds its
steps, `arrow.mjs` the arrow's geometry). Its steps follow the page, and it never loads or changes anything
except when you ask it to run `1 2 +` for you. An idle visitor sees a quiet "Need help? Start here" link
near the prompt, but the guide never starts automatically and does not store a preference.
A shared link carries the program and the standard input text in the URL fragment (nothing is sent
anywhere); opening it loads them into the editor without running anything.

The program picker has four groups: **New puzzles** and **Past puzzles** (only when a provider supplies
some, such as Playground+, whose are written for the player), **Practice puzzles** (the playground's own)
and **Examples**. A provider marks a puzzle `recorded` and, once it was played, `played`. The goal panel
counts the hints used so far ("3 hints available (1 used; the first is free)") from the runtime's hidden stacks.
Selecting a puzzle starts a fresh machine and
silently evaluates its setup source, then focuses the prompt. Read the level's comments and
interact using its words (for example, `42 (ANSWER) PUSH guess`). Its completion check is Bo code,
so a puzzle needs no special playground API. Levels live in `examples/puzzles/`; put their title,
goal, hint count, and optional multiline description in the opening `;@puzzle` comment header (it also
accepts `;@tags`, `;@difficulty`, `;@solution`, `;@right` and `;@wrong`, which describe a puzzle for tools that
check or record it and do not affect the page). `;@freehints N` (0 to 2) makes the first N hints free: the
runtime reads `puzzle.free` and does not record those on `puzzle.hint-used`, and the goal panel says so. Use paired
backticks to render inline Bo code in titles, goals, and descriptions. Active puzzles
automatically hide `puzzle.*` implementation stacks; `@hide` remains available for other names. Add only its
file name to `PUZZLE_FILES` in `playground/puzzles.mjs`, since a static browser cannot enumerate the
directory. `puzzles/lib.bo` supplies the shared `guess`, `hint` and `reveal` words (`filter` comes from the standard library); list it in
`PUZZLE_SUPPORT_FILES`. A puzzle lists its hints, in order, as a list of texts pushed onto
`puzzle.hints` (`("first" "second") (puzzle.hints) PUSH`; each `hint` shows the next one and then
repeats the last, and the header's hint count should match). `reveal` gives up: it shows the text on
`puzzle.reveal`, and a later correct `guess` reports that the solution was revealed. The runtime
also keeps a record of the play on hidden stacks, for an application that observes it (see
`onEvent`): `puzzle.last` holds each guess's result (0 missing, 1 wrong, 2 solved, 3 error), and
`puzzle.mismatch` the first pair a check compared with `puzzle.eq` (an `=` that also remembers a failure) and
found different.
Hidden-stack counts appear in the stack panel’s “Not shown” line without
revealing their names or contents. If a player definition raises an error during `guess`, the
checker restores the prompt stack and shows a generic retry message rather than raw diagnostics.
Puzzles can also validate the default stack itself: `07-order-three.bo` uses `snapshot` to make
the visible stack arrangement the goal. `09-submit-stack-program.bo` shows a puzzle-specific
`restart` word, a visible submitted-program stack, and a custom scored completion message.

No stacks are displayed on a fresh page or after "Reset everything" (which `exit` typed at the
prompt does too, with a message giving the exit status). Once something is on a stack
they appear (the space above the title shrinks) and stay, showing "empty" when nothing is left.
Hovering over a stack shows icons for quick operations: duplicate, swap the top two, drop the
top, and empty it. Clicking one writes the line it stands for under the prompt (for example
`1 () ROLL`, or `1 (s) PUSH (s) ROLL` for a stack named `s`, because
`PICK` and `ROLL` read their index from the stack itself) and evaluates it like
anything typed there. Locked stacks and, for library words the program redefined, everything but
Drop are disabled. Locked stacks have a purple outline and a `locked` badge in their header.

Fast run: Run starts the program on a fresh machine without the stepper, which is faster (about 2x
on the examples) but can only be paused by a breakpoint (`@`); Stop then restarts the machine. A program already loaded in
the stepper (paused) is still finished by Run in the stepper.

The header shows the state: green ready, yellow paused, blue running, red error.

Library and kernel stacks are hidden by default: open "Library and kernel stacks" and search to
look at them. Light and dark themes follow the system setting, with a toggle in the header.

## Running it

```
source ~/emsdk/emsdk_env.sh      # Emscripten, see the top-level README
make -C c wasm                   # builds wasm/build/ (git-ignored)
make playground                  # serves the repository root and opens http://localhost:8000/playground/
```

`make playground PORT=9000` picks another port, `OPEN=0` skips the browser (or run
`python3 tools/serve_playground.py [--port N] [--no-open]`; `python3 -m http.server 8000` from the
repository root also works). A static server is needed (browsers do not load ES modules or
WebAssembly from `file:`), and it must serve the repository root, because the page loads `../wasm/` and
fetches `examples/`, and `include/` is embedded in the WebAssembly build.

## How it is organised

The layers are independent, so that the view can be replaced by a UI framework later without
touching the rest. The WebAssembly runtime itself, and its JavaScript wrapper `bo.mjs` (`eval`, `include`,
the debugger `debug.*`, `state()`, `stacks()`, `stack()`), are in [`../wasm/`](../wasm/README.md).

| File | Role |
|---|---|
| `session.mjs` | The operations a UI needs, as one async interface that carries only JSON. |
| `worker.mjs`, `client.mjs` | The session in a Web Worker (a stuck program cannot freeze the page), and clients with the same interface: `createWorkerClient` for the page, `createLocalClient` for Node tests. |
| `store.mjs` | Application state and actions (step, run in chunks, stop, restart, library search, ...). No DOM. An optional `onEvent` observer option receives one event per action (code, result, machine state before and after); the playground leaves it unset. |
| `views.mjs` | Pure functions from state to DOM nodes (`h()` builds elements). They only call the `actions` they receive. |
| `editor.mjs` | CodeMirror 6 with the Bo language and the current-line marker. |
| `stackops.mjs` | The Bo line behind each stack icon, and which icons a stack offers. |
| `history.mjs`, `share.mjs`, `menu.mjs`, `sidebar.mjs` | Prompt history (Up/Down), share links, the `+` menu and toast, and the sidebar's tab and resizing; none touches the machine. |
| `app.mjs`, `index.html`, `style.css` | Wiring and layout. |
| `config.mjs` | Optional extension points (`onEvent`, `puzzleProvider`, `beforeAction`) that an application built on the playground sets before importing `app.mjs`. The published page never sets them. |
| `examples.mjs` | The examples offered in the page. |
| `puzzles.mjs` | The puzzle header parser and the built-in puzzle provider (`createStaticPuzzleProvider`), which `app.mjs` uses unless `config.puzzleProvider` replaces it. A provider has `load()` and, optionally, `subscribe(callback)` to announce puzzles that arrive while the page is open (the page adds them to the picker and shows a toast). |

`store.mjs` and `views.mjs` map directly onto a framework: the store is the state container, each
view function is a component taking its props from the state.

## What is hidden, and why

The machine marks everything loaded at start (the standard library) as the baseline. A stack is
shown if it is the default stack, new, or has definitions the baseline does not have (`shadows`).
Library, kernel and empty stacks are only counted. See `c/debugger.inc`.

The library's helpers are private words (`__name`, owned by the file that defines them): they are real
words, counted with the library but never listed, and stepping through a library word shows a helper by
name. The search for library stacks does not offer them.

## Fonts

`fonts/` holds self-hosted woff2 files (latin subset, SIL Open Font License, licenses alongside):
JetBrains Mono and Cousine for code (`--mono` in `style.css` picks one) and Truculenta, Voltaire and
Mouse Memoirs for the title (`--title`). The page makes no request to a font service. `style.css` starts with a table of
contents and comments on what each rule controls.

## Vendored editor

`vendor/codemirror.js` is a bundle of CodeMirror 6 and `jupyterlab/src/bo.ts` (the same generated
Bo language the JupyterLab extension uses). To rebuild it:

```
cd playground/vendor-src && npm install && npm run build
```

## Tests

```
node playground/test_puzzles.mjs    # puzzle starter and intended solution
node playground/test_store.mjs      # the store through the in-process client
node playground/test_views.mjs      # pure view helpers
node playground/test_helpers.mjs    # prompt history and share links
node playground/test_stackops.mjs   # the stack icons: generated lines run against the machine
```

`make test-playground` runs them, and `tests/test_wasm.py` from the normal Python test suite, when a
WebAssembly build exists. The runtime's own tests are in `wasm/`.
