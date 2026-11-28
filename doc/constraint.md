# Constraint programming

`include/constraint.bo` solves problems over integer variables: you say which
values each variable may take and how the variables relate, and the library
searches for values that satisfy every constraint. It is written in plain Bo,
with no kernel support, in the spirit of Prolog's CLP(FD). It is not part of
`std.bo`; load it explicitly:

```bo
"include/constraint.bo" require
```

## A first model

```bo
"first" problem                 ; every model starts by naming its problem
(X Y) 0 10 : setdomain          ; X and Y are integers from 0 to 10
(X Y +) (10) #=                 ; X + Y = 10
(X Y -) (4) #=                  ; X - Y = 4
(X Y) label                     ; search: leaves 1 when it finds a solution
X Y                             ; the variables are now ops holding their values: 7 3
```

- **Variables are ops.** A variable's value lives on its own stack. Until the
  solver binds it the stack is empty, and running the op raises
  `Existence-Error` as for any undefined op.
- **A domain is a list of integers.** `1 9 :` gives a range, but any list works:
  `(Color) (1 3 7) setdomain`. `(X)` is a list of one op, so the same ops
  declare one variable or many.
- **Expressions are quotations**: `(X)`, `(3)`, `(1000 S * 100 E * + ...)`.
  Both sides of a relation are expressions.

## Operations

| Op | Effect | Meaning |
|---|---|---|
| `problem` | `( S -- )` | start the problem named by the string `S`, forgetting the previous one |
| `setdomain` | `( L D -- )` | declare the ops of `L` as variables with the domain `D` |
| `getdomain` | `( V -- D )` | the current domain of the variable selected by `V`, such as `(X)` |
| `#=` `#\=` `#<` `#<=` `#>` `#>=` | `( L R -- )` | relate the expressions `L` and `R` |
| `#in` | `( L D -- )` | the variables of `L` take values in `D` |
| `alldiff` | `( L -- )` | the variables of `L` take pairwise different values |
| `label` | `( L -- 0\|1 )` | find a solution and bind the variables, or leave 0 |
| `solutions` | `( L -- S )` | every solution, as lists of the values of `L` |
| `consistent` | `( -- 0\|1 )` | 0 once a constraint has been found impossible |
| `delay` | `( G -- ... )` | run `G` now, or as soon as the variables it needs are bound |

`solutions` leaves the problem as it was, so it can be called again. `label`
keeps the solution it found: the domains of its variables are then single
values. After a search, start a new problem to solve again from scratch.

```bo
"pairs" problem
(A B) 1 4 : setdomain
(A) (B) #<
(A B +) (5) #=
(A B) solutions                 ; ((1 4) (2 3))
```

## How constraints work

Posting a constraint narrows the domains right away, a step called
propagation: after `(X Y +) (10) #=` and `(X Y -) (4) #=`, X is in 4..10 and Y in
0..6 before any search. A narrowed domain wakes only the constraints of that
variable, until nothing changes. Then `label` picks the variable with the
smallest domain and tries its first value. If propagation then finds a
contradiction, it backtracks and removes that value instead.

- **Linear expressions** (`+`, `-`, and `*` by a constant, at the top level of
  the quotation) narrow the lowest and highest values of each variable. This
  scales to many variables: SEND + MORE = MONEY is one equation over eight
  digits.
- **Any other expression**, such as `(X Y *)` or `(A B - abs)`, falls back to
  trying every combination of the values of the variables it mentions, keeping
  the values that some combination supports. That is fine for constraints over
  two or three variables, but grows quickly beyond.
- **`alldiff`** removes the value of a variable from the others once it is
  determined, and fails when fewer distinct values remain than variables.

Constraints must be pure: the fallback runs them many times. Variables are
recognized at the top level of an expression only, not inside a nested
quotation or inside an op that the expression calls.

## Delayed goals

`delay` runs a program as soon as the variables it needs have values. It's
useful to report a result, or to act once the solver has decided a variable:

```bo
"pairs" problem
(A B) 1 4 : setdomain
(A B * "A * B = " emits say) delay    ; A and B are unbound: the goal waits
(A B +) (5) #=
(A) (1) #=                            ; A = 1, so B = 4: prints A * B = 4
```

Running a goal that meets an unbound variable undoes what the attempt left on
the stack and parks the goal on that variable. Binding the variable runs the
goal again, which may then wait for another variable.

## One problem at a time

There is one current problem, and every model starts with `"name" problem`. It
forgets the variables, constraints and delayed goals of the previous problem,
and unbinds the values the solver gave them. The library checks that you do
this:

- **Declaring a variable that the problem already has** raises `Domain-Error`
  with data `((V) name)`, such as `((Q1) "8-queens")`. This is the usual sign of
  a missing `problem` between two models that reuse variable names.
- **Declaring a variable before any problem** raises `Domain-Error` with data
  `((V) "")`.
- **Constraining or searching an op that is not a variable** raises
  `Existence-Error ((V))`, as running it would.

A constraint that cannot hold, such as `(N) (2) #=` with N in `(1 3 5)`, makes
the problem *inconsistent*, as in Prolog: it is not an error, but there is no
solution. Later constraints are ignored, `label` leaves 0 and `solutions`
leaves `()`. `consistent` tells whether this has happened. Its 1 means that no
contradiction was found *so far*: propagation alone does not prove that a
solution exists, only the search does.

## How it is built

The library is an exercise in Bo's own means:

- **Stacks are the solver state.** Each variable V has a stack `V.dom` of
  domains and a stack `V.cons` of constraints. Narrowing a domain pushes the
  smaller one, so backtracking only pops back to a saved depth: the stacks are
  the undo log.
- **Constraints are programs.** A constraint is a quotation holding its data
  followed by its propagator, so the propagation queue and the wake lists
  simply hold code to run.
- **Expressions are analysed as data.** To compile a linear expression, the
  library replaces `+`, `-` and `*` in the quotation with ops on symbolic sums,
  then runs it with each variable bound to its own term.
- **Unbound variables are what drives `delay`.** Running an op whose stack is
  empty raises an error naming it, which is the hook that parks a delayed goal
  on its variable.

It is far slower than a native solver: hard puzzles take seconds, where
Prolog's CLP(FD) takes milliseconds. The goal is to show what the language
can express, not to compete.

## Examples

- [`examples/16-constraints.bo`](../examples/16-constraints.bo): a tour of the
  library, with map colouring, SEND + MORE = MONEY and the zebra puzzle.
- [`examples/extra/queens.bo`](../examples/extra/queens.bo): N queens, a board
  and a count of all the solutions.
- [`examples/extra/sudoku.bo`](../examples/extra/sudoku.bo): Sudoku with
  `alldiff` on rows, columns and boxes.

