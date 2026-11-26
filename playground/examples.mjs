// The programs of examples/ offered by the playground. `input` is the standard input the
// example expects (taken from examples/expected/NAME.in). test_store.mjs checks the list
// against the examples folder.
export const EXAMPLES = [
    { file: "01-classics.bo", title: "Classics: factorial, Fibonacci, gcd, Collatz, primality" },
    { file: "02-lists.bo", title: "Lists: functional processing" },
    { file: "03-primes.bo", title: "Primes: three ways" },
    { file: "04-sorting.bo", title: "Sorting and searching" },
    { file: "05-wc.bo", title: "wc: count lines, words, characters (stdin)", input: "05-wc.in" },
    { file: "06-text-filters.bo", title: "Text filters (stdin)", input: "06-text-filters.in" },
    { file: "07-numerals.bo", title: "Numerals: bases and Roman numerals" },
    { file: "08-matrix.bo", title: "Matrices" },
    { file: "09-numeric.bo", title: "Numerical methods" },
    { file: "10-dictionaries.bo", title: "Named stacks as dictionaries" },
    { file: "11-code-as-data.bo", title: "Code is data" },
    { file: "12-errors.bo", title: "Errors and catch" },
    { file: "13-parallel.bo", title: "Parallel execution" },
    { file: "14-bobo.bo", title: "Bobo, the mascot, drawn as text" },
];

/** Support files every example may include. */
export const SUPPORT_FILES = ["lib.bo"];
