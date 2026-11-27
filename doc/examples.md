# Examples

The programs in `examples/` explicitly load
`include/std.bo` with `require`, except for the Breeze tribute, which loads only
the I/O module. They are tested on both implementations against
`examples/expected/`. Run an example from the repository root, for example
`c/bo examples/02-lists.bo`.

The programs use a recommended (not enforced) vertical layout with the quotations go on their own indented lines:

```
    (
        (dup 0 =) 
        (drop 1) 
        (dup 1 - fact *) 
    ifte
    )
    (fact)
PUSH
```
Helper ops are private ops with two leading underscores (for example `__lenacc` in `include/list.bo`), as explained in the [language guide](language.md#private-ops).

The examples use only the standard library: for example `say`, `sum`, ranges with `:` (`1 10 :` is `(1 2 ... 10)`), dictionary keys with `tagkey`, and variables with `set`/`get`/`incr`. `filter` is a standard-library op (with `mask`, `reverse`, `startswith`, `endswith` and `contains`, in `include/list.bo`); its predicates receive element units; `selector` converts a string holding a valid op name to a selector, and `tagkey` encodes a value under a selector tag as a named-stack selector.

| File | Shows |
|---|---|
| `01-classics.bo` | recursion with names and with `rec`, `loop`, Fibonacci, gcd, Collatz, primality |
| `02-lists.bo` | `map`, `filter`, folds, `range`, `split`, composing functions as lists |
| `03-primes.bo` | trial division, the sieve by filtering with predicates built as data, prime factorization |
| `04-sorting.bo` | quicksort, merge sort, binary search (named stacks as variables) |
| `05-wc.bo` | `wc` over standard input: `read`, counters in named stacks |
| `06-text-filters.bo` | reading all input into a list, upper case, ROT13, counting |
| `07-numerals.bo` | numbers in any base, parsing, Roman numerals |
| `08-matrix.bo` | transpose, product, identity, powers, Fibonacci by matrix power |
| `09-numeric.bo` | Newton's square root, midpoint integration, a series, Monte Carlo with an exact generator |
| `10-dictionaries.bo` | memoization, word splitting and word frequencies with keys computed at run time |
| `11-code-as-data.bo` | compiling and differentiating polynomials as lists, defining ops by computed names, Newton's method |
| `12-errors.bo` | `catch`, `throw`, error lists, recovery, rethrowing |
| `13-parallel.bo` | ordered isolated workers, multi-value results, named-stack isolation, nesting, worker-error handling |
| `14-bobo.bo` | the mascot drawn as text from a run-length encoded picture (palette lookup with `nth`, `loop`, `foreach`); defines `bobo` and shows it |
| `15-breeze-hash.bo` | a tribute to Breeze: running code represented as numbers and lists with a `#` operator |

`examples/extra/` holds further, smaller programs (many after examples of other languages such as Uiua); they are not tested and have no expected output.

Two conventions that the examples rely on and that are easy to trip over: the value of a variable is stored as itself (`0 (COUNT) PUSH`) and naming it pushes it, but a *list* stored in a stack is a program, so naming it runs it; read a list value with `(NAME) TOP` or define an op that pushes it with a doubled paren, `((1 2 3)) (DATA) PUSH`. And `ift`/`ifte` take their condition as a list to run (`(cond) (then) ift`); when the truth value is already on the stack use `() (then) (else) ifte`.

```
"three numbers on the default stack" drop
1 2 3

"one list on the default stack" drop
(1 2 3)

"a string is a list of code points: same as (97 98 99)" drop
"abc"

"define SUCC; 5 SUCC gives 6" drop
    (1 +)
    (SUCC)
PUSH
5 SUCC

"override SUCC; 5 SUCC gives 7" drop
    (2 +)
    (SUCC)
PUSH
5 SUCC

"restore the previous definition; 5 SUCC gives 6 again" drop
(SUCC) POP drop
5 SUCC

"a constant is a stack whose top is a number; pi 2 * gives 6.28" drop
(3.14) (pi) PUSH
pi 2 *

"absolute value (the else-branch is left empty)" drop
    (dup 0 <)
    (neg)
    ()
ifte
```

### Factorial: are `lambda`/`rec` necessary?

No. A recursive definition is just a named stack that calls itself, which is the normal way to define anything in Bo:

```
    (
        (dup 0 =)
        (drop 1)
        (dup 1 - FACT *)
    ifte
    )
    (FACT)
PUSH

"10 FACT gives 3628800" drop
10 FACT
```

`lambda` only adds *anonymous* recursion (useful inside a definition that should not create a name):

```
"gives 120" drop
5
    (
        (dup 0 =)
        (drop 1)
        (dup 1 - rec *)
    ifte
    )
lambda
```

and it is a kernel primitive pair: `LAMBDA` runs the program in a frame labelled by its selector and `REC` re-enters the innermost frame with the same label, so `lambda` and `rec` are the wrappers with the anonymous label `()`. The frame lives on the control stack, so an error that unwinds past it leaves nothing behind, and recursion in tail position runs in constant space. [Private ops](language.md#private-ops) use named labels, which keeps a callback from re-entering the wrong program.
