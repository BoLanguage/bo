# Extra examples

Additional Bo programs, kept outside the curated examples one level up. They are not run by
the test suite, have no expected output and are not listed in the playground, so a new one can
be added by just dropping a `.bo` file here (no rebuild needed).

Run one from anywhere with, for example:

    c/bo examples/extra/palindrome.bo

Relative `require`/`include` paths are looked up next to the including file, then in the current
directory, then under the library home, so `"include/std.bo" require` works as is.

Good candidates can later be promoted to a numbered example in `examples/` (with an expected
output in `examples/expected/` and an entry in `playground/examples.mjs`).
