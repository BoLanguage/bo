# Errors

An error is a list `(KIND WHERE DATA SOURCE LINE)`; see [the language](language.md#errors). The kinds raised by the kernel are:

| Kind | Raised when |
|---|---|
| `Type-Error` | an operand has the wrong type |
| `Stack-Error` | a stack has too few values, or an op leaves the wrong number |
| `Existence-Error` | an op is executed that has no definition and is not a primitive |
| `Permission-Error` | a locked stack is changed |
| `Io-Error` | the operating system fails to read, write or start something |
| `Representation-Error` | a string cannot be an op name (`SELECTOR`) |
| `Syntax-Error` | source code cannot be read: unmatched parenthesis, unterminated string, bad escape, number out of range, invalid op name |
| `Domain-Error` | an operand has the right type but a value the operation cannot take: division by zero, a negative dimension, an index or axis out of range, an empty slice, an invalid exit status |
| `Shape-Error` | the shapes of array operands do not fit: element count, rank, inner dimensions |
| `Resource-Error` | a result would be larger than the limit of `2^32 - 1` elements |
| `Cycle-Error` | `include` would load a file that is already being loaded (files that include each other); the data is the file name. `require` skips such a file instead |
| `Evaluation-Error` | a result is not a finite number (overflow), or a `PARALLEL` worker aborts |
| `Debug-Error` | `STEP`, `NEXT`, `CONTINUE` or `STOP` is used when no program is paused (see [debugging](debugging.md)) |

Any other selector can be thrown, so programs may define kinds of their own.

## Source errors

Source code that cannot be read raises `Syntax-Error` with data `(MESSAGE LINE)`. At top level, and in a file loaded with `include`, that happens before any of it runs, so a syntax error late in a file stops the whole file. `include` raises it with `WHERE` `(INCLUDE)`, so it can be caught; at top level the error is reported with `WHERE` `(LOWER)`. `PARSE` reads source code held in a string, and `eval` runs it:

```bo
"1 2 +" parse                   ; leaves the program (1 2 +) without running it
"1 2 +" eval                    ; leaves 3
("(1 2" eval) (drop) catch      ; raises (Syntax-Error) at (PARSE) before running anything
```

Errors raised by code that `eval` runs report the line of the `eval` call.

## Errors in included files

A runtime error in an included file is caught by a `catch` (or the body of a `call`) around the `include`, however deeply files are nested. The error keeps the source and line where it happened and is recorded once; the definitions the file made before the failing form remain, and the rest of the file does not run. A `catch` inside the file handles the error first. Without any `catch` around the `include`, the `EXCEPTION` handler runs at the point of failure and the file continues after it.

A bare name that looks like a number (`1e`, `1.2.3`) is not a syntax error: it is an ordinary op and raises `Existence-Error` only if executed.
