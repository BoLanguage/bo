# Debugging

Bo has a small debugger built from a few ops. A `@` in a program pauses it; the prompt then
runs *at that point*, on the program's own stacks, until you step, continue or stop. There is also a
non-pausing probe, `watch`, for scripts and notebooks. This page covers the native `bo` prompt; the
[playground](../playground/README.md) works the same way at its prompt (see [below](#the-playground)).

## A first session

```
| (1 @ +) (succ_debug) PUSH
| 2 succ_debug
paused in succ_debug
  stack: 2 1
  step: +
@ ps
  1: 2
  0: 1
@ 10 +
@ step
| ps
  0: 13
```

`@` is the default-stack adapter of the primitive `BREAKPOINT`. When it runs, the line stops, the
prompt says where (`paused in` the user op that is running, if any), shows the stack and what a
`step` would do next, and changes from `| ` to `@ `. Everything you type there runs at the pause point, so `ps`,
`where`, `watch` and any change to the stacks work; `10 +` above changed the stack of the paused
program. `step` resumed it, the pending `+` ran, the program ended and the normal prompt came back.

The prompt pauses programs when its input is a terminal, or with the `--debug` option (which is how
a script feeding `bo` through a pipe can be tested). A breakpoint does nothing anywhere else: in a
script (`bo file.bo`, `-e`) run without `--debug`, in an included file, inside `PARALLEL` or a
callback op that the runtime calls (a nested run), and in the Python runtime. A forgotten `@`
never hangs a program. In a Jupyter notebook `@` shows where the cell is and goes on; see
[the notebook guide](notebook.md#debugging-in-a-notebook).

## Debugging a file

```
$ bo --debug program.bo
paused
  stack: (empty)
  step: (105 110 99 108 117 100 101 47 115 116 100 46 98 111)
@ step
...
@ continue
```

With a file (or `-e CODE`), `--debug` runs the program under the debugger and stops before its first
item, with the `@ ` prompt: `step` and `next` go on from there, and `continue` runs to the next `@`
or to the end. (A string shows as the list of its character codes, as everywhere in Bo.) With
several programs on the command line, only the first one stops at its start; the others run
until a breakpoint. The program is loaded exactly as `bo program.bo` loads it: private `__`
ops, error messages naming `program.bo` and its line, relative includes, and the exit status
(1 after an error, the status given to `exit`) are the same. The file is your code even when it
lives under `include/`, so `step` goes into it: that is how to debug the library itself.

Two things to know. The end of the input continues the program (a note says so), so nothing that
cannot answer, such as `bo --debug program.bo < /dev/null` in a script, stops it half way. And a
program that reads standard input competes with the prompt for it, so give it its input in a file
that it opens instead. Breakpoints in files that the program includes do nothing; the ones in its
own top-level code and in the ops it defines pause.

## The ops

| Op | Primitive | What it does |
|---|---|---|
| `@` | `BREAKPOINT` | pause here (when the program can be paused) |
| `step` | `STEP` | resume; pause before the next op, also inside the definitions it calls |
| `next` | `NEXT` | resume; pause before the next op at the same depth or shallower |
| `continue` | `CONTINUE` | resume until the next `@` or the end |
| `stop` | `STOP` | drop the paused program, keeping the stacks |
| `backtrace` | `BACKTRACE` | the programs being run, as a list |
| `where` | | print `backtrace` readably |
| `watch` | | print a label and the top items without stopping |
| `trace`, `untrace` | | write a line on entry to and exit from an op (see below) |
| `@if` | | `@` when the value on top of the stack is true |
| `break-on-error` | | pause where an error that nothing catches happens |
| `break-off-error` | | undo `break-on-error` |

`step`, `next`, `continue` and `stop` raise `Debug-Error` when nothing is paused (they only make
sense at the `@ ` prompt). They only record what to do; the prompt carries it out when the line
ends, so `step` can be followed by other ops on the same line.

### `step` and `next`

`step` runs the item shown after `step:` and stops before the next one, going into the definitions
you wrote. Numbers and lists are steps too, as well as ops. `next` runs that item, and everything
it calls, and stops at the following item of the current definition (or of the one that called it,
when the current one ends). Neither stops inside the library or on a kernel primitive such as
`ADD`: `+` is one step, not three. For a library op, `step` and `next` are the same.

```bo
(1 +) (succ) PUSH
(@ succ succ) (twice) PUSH
0 twice
; paused in twice, step: succ
;   step -> paused in succ, step: 1      (inside the first succ)
;   next -> paused in twice, step: succ  (the first succ ran; this is the second one)
```

### `where`

```
@ where
succ_debug: (1 @) | (+)
outer: (0 succ_debug) | (5)
```

One line per program being run, innermost first: the op that called it (`line` for the program
the prompt started), the elements that already ran, a bar, and the elements still to run.
`backtrace` gives the same as a list of `(NAME PROGRAM INDEX)` for your own tools: `NAME` is a
selector of the calling op (`()` if none), `PROGRAM` the list and `INDEX` the number of its
elements that ran. The outermost program is the unit the runtime executes at once: a whole line in
the C runtime, a single top-level form in the Python runtime, so a backtrace can differ there.

## `watch`

`(label) n watch` is `watch ( L n -- )`: it writes the string `L` and a list of the top `n` items to
standard error, and changes nothing. It needs no pause, so it works in scripts, pipelines and
notebooks, and its output stays out of the program's own output.

```bo
(1 "after-1" 1 watch + "after-add" 1 watch) (succ_watched) PUSH
2 succ_watched
; stderr: after-1: (1)
;         after-add: (3)
```

With `n` 0 it writes the string alone, which marks that a place was reached.

## Tracing an op

`(op) n trace` makes every call of `op` write two lines to standard error, indented by how deeply
traced ops are nested: `> op` with the top `n` items of the stack when it is entered, and `< op`
with the top `n` items when it ends. With `n` 0 it writes the names only. `(op) untrace` puts the
op back; tracing it again replaces the old trace.

```bo
((dup 2 <) () (dup 1 - fib swap 2 - fib +) ifte) (fib) PUSH
(fib) 1 trace
3 fib
; > fib (3)
;   > fib (2)
;     > fib (1)
;     < fib (1)
;     > fib (0)
;     < fib (0)
;   < fib (1)
;   > fib (1)
;   < fib (1)
; < fib (2)
```

It is a library op, not a primitive: a traced op is a new definition on the op's stack that
runs the old one between the two lines. Consequences: a traced op no longer calls its last op as
a tail call (deep recursion uses more stack), a call that fails prints no exit line, and the selector
that names the op must be written as for `PUSH` (`(fib)`). `step` inside a traced op stops at
the wrapper's own ops as well.

## Conditional breakpoints

`@if` takes a truth value (positive is true) and pauses only then:

```bo
(dup 100 > @if 2 *) (double_big) PUSH      ; pauses only for values above 100
```

## Stopping when an error happens

`break-on-error` makes an error that nothing catches pause where it happened, with the operands
that the failing op was given still on the stack and the error on top. It prints what failed;
`continue` then reports the error as usual and ends the line.

```
| break-on-error
| 7 (1 0 /) apply 5
error: Domain-Error DIV
paused
  stack: 7 1 0 ((Domain-Error) (DIV) (1 0) (115 116 100 105 110) 1)
  step: rethrow
@ continue
Uncaught Exception -- stdin:1 Domain-Error (DIV) (1 0)
| break-off-error
```

An error that a `catch` or a `call` handles does not pause. `break-on-error` is a handler on the
`EXCEPTION` stack (see [errors](errors.md)); `break-off-error` removes it, but only if it is still
the last handler, so one that you pushed afterwards is left alone. In a script, where nothing can
pause, it only prints the line and reports the error.

## Details

- **What a prompt line can do at a pause.** Anything: it is a nested run at the pause point. It
  cannot pause itself (`@` does nothing there), and an error in it is reported and ends only that
  line; it is not caught by a `catch` of the paused program.
- **Speed and specialization.** A line runs under the step driver, which costs nothing measurable
  while no breakpoint is reached. `step` and `next` turn specialized operations off, so that every
  op is one list item; `continue` turns them on again. Programs that were already running when the
  pause happened keep the code they were compiled to: a literal `ifte` or `loop` in them has no frame
  of its own, so `where` shows fewer programs than the source nests and `step` may enter a branch
  one op later. Everything that starts after the pause is exact.
- **Nested runs.** A breakpoint reached while a file loads, inside `PARALLEL`, or in an op the
  runtime calls back (a comparison given to a sort, say) does nothing; ops defined in a file
  and called later from the prompt pause normally.
- **Private library ops.** Which code is the library's is known from where its lists were read:
  files under the `include/` directory of the library home. Your own files are your code.

## The playground

The playground's prompt is a debugger in the same way. A line typed there runs under the same
driver, and when it reaches `@` the prompt turns yellow and says what comes next
("Paused before + · Type step, next, continue or stop, or any Bo to run here"), the header says
"paused at a breakpoint", and the stacks, the Next panel and the editor's Step, Run and Abort buttons
describe the paused program. `step`, `next`, `continue` and `stop` typed at the prompt act like the
buttons. A program in the editor pauses at `@` too: after Run (fast run included, which otherwise
cannot be paused) the line of the breakpoint is marked, and Step and Run go on from there.

The editor's buttons map onto the ops like this: Step is `step`, Run is `continue` (it stops at
the next `@`), Abort is `stop`, and `next` is the step size "op, over calls". The step size is
how big one Step is: "op" stops before every op, even inside `+`; "op, over calls" runs what
an op calls without stopping in it; "line" and "line + user ops" go by lines. The editor's Step
does not stop at numbers and lists, as the prompt's `step` does; the Next panel does show a number
or list that is about to be pushed after a breakpoint.
