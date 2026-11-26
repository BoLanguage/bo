# A first Bo program

This tutorial is a short path through Bo's unusual parts. It assumes you have
loaded the standard library. In the repository, start the C REPL with:

```sh
make -C c
c/bo
```

and load the library at the first prompt:

```bo
"include/std.bo" require
```

In the [playground](../playground/README.md), the standard library is loaded
automatically. Enter each example at the prompt and watch what remains on the
default stack.

## 1. Values go on a stack

Enter:

```bo
1 2 +
```

Bo reads the program from left to right. `1` and `2` are pushed, then `+`
removes both and pushes `3`. The left operand is below the right operand, so
`10 3 -` evaluates to `7`.

Try:

```bo
1 2 3
drop
```

`drop` removes the top item, leaving `1 2`. Use `clear` to empty the default
stack before the next section.

```bo
clear
```

## 2. A quotation is inert code

Parentheses build a list. A list is data until something executes it:

```bo
(1 2 +)
apply
```

The first line pushes one list. `apply` unquotes its elements, which executes `+` leaving `3`.
Words can also be kept in a list as data:

```bo
(dup)
```

This pushes the word `dup` inside a one-element list. It does not execute
`dup`.

## 3. Stack operations rearrange values

Start with three values:

```bo
clear 1 2 3
```

Now try the following one at a time:

```bo
dup
drop
swap
```

- `dup` copies the top value.
- `drop` removes the top value.
- `swap` exchanges the top two values.

The exact stack after each step is visible in the playground. In the C or
Python REPL, `ps` prints it; `clear` restores an empty stack.

## 4. Definitions are values on named stacks

A Bo word names a stack. Executing the word normally runs the list on top of
that stack. Define `double` by pushing a quotation onto the stack named
`double`:

```bo
clear
(2 *) (double) PUSH
```

Now run:

```bo
clear 5 double
```

The result is `10`. `(2 *)` is the body, while `(double)` is a stack selector:
a one-element list containing the word `double`. `PUSH` transfers the body
from the default stack to that named stack.

Definitions can be replaced:

```bo
(3 *) (double) PUSH
clear 5 double
```

The second definition is now on top, so the result is `15`. Pop it to reveal
the previous definition:

```bo
(double) POP drop
clear 5 double
```

The result is `10` again.

## 5. Conditionals execute quotations

`ifte` takes a condition and two branches. Each argument is a quotation:

```bo
(7 10 <) (1) (0) ifte
```

The condition leaves a positive value, so the true branch runs and leaves
`1`. The false branch is used for a zero or negative result.

This is the factorial definition used in the examples:

```bo
(
    (dup 0 =)
    (drop 1)
    (dup 1 - fact *)
    ifte
)
(fact)
PUSH
```

Run it:

```bo
5 fact
```

The result is `120`. The word calls itself because `fact` is resolved when the
body runs, rather than frozen when it is defined.

## 6. Stacks can hold data as well as code

Push a number onto a named stack:

```bo
clear 42 (answer) PUSH
clear answer
```

Naming the stack pushes its top number, so the default stack receives `42`.
A list stored on a named stack is a program and would execute when its name is
used. To inspect a list-valued stack without executing it, use `TOP`:

```bo
((1 2 3)) (data) PUSH
(data) TOP
```

The doubled parentheses mean that the stored value is a list whose only
element is the list `(1 2 3)`. `TOP` copies that stored outer list without
executing it.

`PUSH` stores what it is given, so `42 (answer) PUSH` keeps the number and
`(42) (answer) PUSH` keeps the list `(42)`. Both leave `42` when `answer` is
called, but `(answer) TOP` tells them apart. Use a list for a definition and a
number for a variable.

## 7. One complete interaction

These lines define a tiny absolute-value word and show the result:

```bo
"include/std.bo" require
clear

(
    (dup 0 <)
    (neg)
    ()
    ifte
)
(abs)
PUSH

-12 abs 12 abs
```

The final default stack contains `12 12`.

## What to read next

- [Language](language.md) explains values, evaluation, words, errors and private words (`__name`) for helpers.
- [Primitives](primitives.md) documents kernel operations and stack effects.
- [Library](library.md) documents default-stack wrappers and derived words.
- [Examples](examples.md) contains larger recursive, list-processing and concurrent programs.
- [The playground](../playground/README.md) explains the editor, debugger, puzzles and stack visualizer.

