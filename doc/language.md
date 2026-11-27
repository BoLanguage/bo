# The language

Bo is a concatenative, postfix, stack-based language. Its small value model
keeps code and data in the same representation: numbers and lists are values,
and ops (short for operators) name stacks whose current contents determine
their behavior. Anything expressible in Bo is intended to be defined in Bo
rather than added as a kernel primitive.

Numbers are IEEE-754 doubles. Integral values are exact up to 2^53; `1` and
`1.0` are equal. Arithmetic does not produce NaNs or infinities.

## Source syntax

Tokens are separated by whitespace. Op names are case-sensitive. Numeric literals use ASCII digits; other Unicode digits can occur in names. A string is a list of Unicode code points; escapes include `\n`, `\t`, `\"`, `\\` and `\s`.

Bo has three kinds of values: numbers, lists and ops. Lists also take a few forms, which may overlap:

| Source | Value | Kind | Form |
|---|---|---|---|
| `42`, `-3`, `2.5` | a number, integral or not (`1` and `1.0` are equal) | number | |
| `()` | the empty list, which is also the default-stack selector | list | null, selector |
| `(-3)` | a list of exactly one element | list | unit |
| `(111 112)` | a list of two numbers | list | |
| `"op"` | a string: the same list `(111 112)` | list | string |
| `(111 (1 2 +) "hello")` | a list of three elements | list | |
| `op` | the op `op`: reaching it runs the top of its stack | op | |
| `(op)` | a unit containing the op `op`, which selects the stack of `op` | list | unit, selector |
| `(1 op)` | a list of the number `1` and the op `op`; run as a program, it is a quotation | list | quotation |

The kind is what `type` returns: `0` for a number, `1` for a list and `2` for an op. A selector is `()` or a unit containing an op; any list run as a program is a quotation. An op in a program runs when it is reached, while an op inside a list is inert data until the list runs. Forth and Joy call ops *words*.

Lists are inert until executed. Outside strings, `;` starts a comment that ends at the next newline.

## Evaluation

A program is a list of values, processed left to right. Numbers and lists are pushed onto the default stack, unless explicitly pushed on a named stack. For example:
```bo
(1 2 3)             ; pushes the list on the default stack
(1 2 3) () PUSH     ; same as above, with () being the default-stack selector
(1 2 3) () APPLY    ; executes the list (default stack will hold 3 elements); same as (1 2 3) apply
(1 2 3) (X) PUSH    ; moves the list to stack X
(X) TOP             ; copies the top of X onto the default stack, leaving X untouched
(X) POP             ; moves the top of X onto the default stack, removing it from X
X                   ; executes the top of X, leaving the definition on X
(X) APPLY           ; pops the top of X and executes it: unlike X, this consumes it
(X) () APPLY        ; executes the list (this in turn executes X); same as: (X) apply
```
Thus, an op executes: the top of its named stack is looked up and, if it is a list, executed as a program; a number is pushed. If the stack is empty, the kernel's native primitive with that name is called when one exists; otherwise execution raises `Existence-Error`.

`APPLY` and `apply` execute a list by processing its elements by the same rule. Thus `(1 2 +) apply` leaves `3` after loading `std.bo`, whereas `(1 2 +)` alone pushes a list. An op can be kept as data inside a list: `(OP)` contains the op `OP`, while `"OP"` contains two numbers.

Definitions live on named stacks: `(1 +) (SUCC) PUSH` defines `SUCC`, and `(SUCC) POP drop` restores any previous definition after loading `std.bo`. References resolve at execution time, so recursive definitions and redefinition work naturally. The kernel starts with its primitives only: uppercase ops such as `ADD`, `DROP` and `PARALLEL`, each acting on a selected stack. `include/core.bo` installs the lowercase default-stack wrappers as ordinary, unlocked definitions, for example `(drop) POP` returns `(() DROP)`. Primitives with a natural symbol get only the symbol as their wrapper (`(+) POP` returns `(() ADD)`; there is no spelled `add`), and every wrapper is defined directly from its primitive, so it costs no second forwarding dispatch. All of them may be overridden or removed just like other definitions. Primitives keep acting on a selected stack, except for the transfer primitives `PUSH`, `POP`, `TOP`, `SNAPSHOT` and `DEPTH`, which exchange values with the default stack.

A stack can hold data as well as definitions, and `PUSH` stores exactly what it is given: `5 (X) PUSH` stores the number `5`, whereas `(5) (Y) PUSH` stores the list `(5)`. Calling either op leaves `5` on the default stack (a number is pushed, a list is run), but they are different values: `(X) TOP` copies `5` and `(Y) TOP` copies `(5)`. Use a list for a definition and a number for a variable or a counter; to keep a list as data without running it when the op is called, wrap it once more (`((1 2 3)) (data) PUSH`).

A named stack comes into existence when something is pushed to it or it is selected by a primitive. `EXISTS` reports whether it does: `(X) EXISTS` is 0 for a stack never used and 1 for the stack of every primitive. `CLEAR` only empties a stack, which continues to exist (as the default stack does, empty or not), while `DELETE` removes it: `10 (X) PUSH (X) DELETE (X) EXISTS` leaves 0, and pushing to `X` again creates it anew. The default stack `()` and locked stacks, which include every primitive's, cannot be deleted (`Permission-Error`). Deleting a primitive's stack after unlocking it only discards the definitions on it: the primitive remains and `EXISTS` stays 1. `DEPTH` is 0 for a stack that holds nothing, whether it is empty or does not exist, so only `EXISTS` tells them apart. `LOCKED` reports whether a stack is locked (every primitive's is, and `LOCK` locks any other; the default stack and a missing stack are not, and `() LOCK` raises `Permission-Error`), and is likewise 0 for a missing stack. `LEXICON` lists every op that has a stack, in order of name, so `DELETE` and `CLEAR` can be mapped over a selection of them. For example, the following delete all unlocked stacks whose name/selector starts with `puzzle.`:

```bo
lexicon
        (apply name "puzzle." startswith)
    filter
        (apply LOCKED 0 =)
    filter
    (apply DELETE)
foreach
```

`PARALLEL` runs one quotation per input item in isolated worker processes and collects final worker stacks in input order; `include/core.bo` defines its default-stack wrapper `parallel`. See [primitives](primitives.md#execution-and-control) for its contract.

## Ops as data

### Stack selectors

The default stack is denoted/referred to as `()`. A named stack selector is a unit containing an op: `(SUCC)` refers to the stack that the op `SUCC` runs. Other values, including `"SUCC"`, `(7)`, `((SUCC))` and `(a b)`, are not valid stack selectors and raise `Type-Error`.
`isselector` tests this complete stack-key form: it returns true for `()` and
for a unit containing an op.

List manipulation operations like `unconsl` and `unconsr` return the removed element as a unit; `consl` and `consr` insert the element of a
unit. For example, `(OP 2) unconsl` gives `(2) (OP)`, and `consl` reconstructs the original list. This permits processing an op without
executing it.

`unittype` inspects a unit's element: `0` for a number, `1` for a list, and `2`
for an op. `apply` on a unit pushes its number or list, but executes its op.
`unit` wraps an existing stack value. The `Value` library also provides
`isnumber`, `islist`, `isunit`, `isinteger` and `isselector` (lowercase aliases in `std.bo`). List callbacks use units: `map` takes a callback
`( unit -- unit )`, and folds and `foreach` pass element units.

### Conversion between selectors and strings

`NAME` converts a selector to the name of its op, a string; `SELECTOR` converts a name back to its selector. For example, `(OP) name` gives `(79 80)`, that is `"OP"`, and `"OP" selector` gives `(OP)`. The default-stack selector `()` and the empty string `""` are the same value, so each converts to itself. Any other name must be a nonnumeric token, without whitespace, parentheses, quotes, semicolons, NUL or surrogate code points. Invalid names raise `Representation-Error`; a valid undefined name can be constructed but raises `Existence-Error` when executed.

### Naming convention

Bo has one shared namespace of ops for the definitions that a program makes public, plus private ops (see [Private ops](#private-ops)). Names follow four conventions:

- **Primitives** are uppercase ops made of letters and digits, never symbols (`ADD`, `PUSH`, `IFTE`). They require a stack selector.
- **Library ops** are lowercase (`dup`, `map`, `emit`) and act on the default stack. Symbolic names (`+`, `<=`, `//`) are lowercase-style wrappers too.
- **Your own stacks and ops** can be named anything, but should preferably be lowercase or Capitalized (camelCase, PascalCase, snake_case and kebab-case are all fine), so as not to interfere with primitives. Primitives are locked, so pushing a definition onto a stack named like one (for example `(DROP) PUSH` or `(REDUCE) PUSH`) raises `Permission-Error`, unless you first unlock it on purpose: after `(DROP) UNLOCK`, a definition shadows the primitive, and popping it restores the primitive.
- **Private ops** start with two underscores (`__mapacc`). In a source file they belong to that file alone and cannot be reached from anywhere else; the library reference omits them.

Symbols are allowed and have no special runtime meaning: `Math.succ` is one op name, not a qualified lookup. Qualifying names can avoid name conflicts in your own code. Because the public library ops share one namespace, redefining a library op changes every library op that calls it; library helpers are private, so they cannot be redefined from outside.

## Private ops

In a source file, an op that starts with two underscores (`__square`) is *private* to that file. It is an ordinary op with an ordinary stack that you define with `PUSH` and call by name, but the reader marks it with an invisible owner, the file. An op and its stack are identified by name *and* owner, so another file, the REPL or `eval` cannot see, call or redefine a private op, and two files may use the same private name without clashing:

```bo
(dup *) (__square) PUSH
((dup 0 =) (drop 1) (dup 1 - __fact *) ifte) (__fact) PUSH   ; recursive: no lambda needed
(__square 1 +) (sq1) PUSH                                    ; public
(__fact __square) (fsq) PUSH                                 ; public
```

The owner travels with the op, so private ops keep working wherever the code that mentions them runs: `(sq1) TOP` gives `(__square 1 +)`, and passing that list to `apply` or to a callback in another file calls the private op. Inside the file `(__square) TOP` shows its definition; elsewhere the name is a different, plain op, and `__square` raises `Existence-Error` (and `(__square) TOP` raises `Stack-Error`, as for any stack that does not exist). `LEXICON` and the stack listings leave private ops out.

- A private op equals only itself: it is not `=` to a plain op of the same name, and `name` gives the name alone, so `name "__square" =` tells nothing about the owner.
- Mutual recursion needs no special form, since a private op is a real op.
- Outside a file (the REPL, a notebook cell, `eval`, `parse`, `selector`) and when ownership is disabled with the `--no-private` option or the `BO_NO_PRIVATE` environment variable, `__square` is an ordinary public op, which makes the private ops of a library visible by name for debugging.
- Loading a file again with `include` or `() INCLUDE` first discards its private ops (see [loading a file again](#loading-a-file-again)). `require` loads a file only once, but a file whose load ended in an error is not counted as loaded, so `require` runs it again after a fix.
- Public libraries must not define ops that start with `__`.

## Loading a file again

`include` and `() INCLUDE` treat a load as a first load: before the file runs, what its earlier load left is taken out.

- **Items it pushed.** The runtime records which file was loading when an item was pushed on a named stack, by the file or by a library op it called. A reload removes those items from every stack, locked ones included, and the file pushes its definitions again on top. Items that other files or the program pushed stay. If `your.bo` pushed 1 on `Y` and `my.bo` then pushed 2, reloading an edited `your.bo` that pushes 3 leaves `Y` as `(2 3)`: the reloaded file goes on top, so reload the files that should win again after it.
- **Locks.** A stack the file locked is unlocked for the reload and locked again by the file. If the reload fails, the lock is put back.
- **Stacks it made.** A stack the file's load made exist (by pushing, or `CLEAR`) stops existing when nothing is left in it. Stacks made by the program or other files stay. Private ops (above) are discarded as whole stacks.
- **Cycles.** `include` of a file that is being loaded raises `Cycle-Error` (data: the file name); `require` skips it.

Only items pushed *while the file loads* belong to it: what the program pushes later stays, and a stack operation other than `PUSH` and `POP` on a named stack (`(Y) ROLL`, ...) makes it forget who pushed its items. Output, open streams and values left on the default stack are not undone. A file that counts its loads by pushing to a stack always finds it back at its starting depth: use `included`, or keep the count outside the file.

## Errors

An error is a list `(KIND WHERE DATA SOURCE LINE)`. `KIND` and `WHERE` are selectors: the kind of failure (`(Type-Error)`, `(Domain-Error)`) and where it happened, usually a primitive (`(DIV)`), or `(EXECUTE)` when an op cannot run. `DATA` lists the offending values, `SOURCE` is a file name as a string and `LINE` a number. Kinds are plain units and need no definition: compare them with `=`, print them with `name`, and raise your own with `throw`:

```bo
(7) (Disk-Full) throw                      ; raises (Disk-Full) with data (7)
(1 0 /) (unconsl apply name emits) catch   ; prints Domain-Error
```

`throw` raises `Type-Error` unless the kind is a unit containing an op. See [errors](errors.md) for the kinds the kernel raises.

## Library

`include/std.bo` loads the standard-library modules. Like the focused modules it needs `include/core.bo`, which the command-line programs load at startup and which an embedding host loads first (the WebAssembly `createBo` does it before the module it is asked to load).
