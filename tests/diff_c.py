"""Differential test: run every snippet executed by the unit tests on both the Python
reference and the C runtime, and compare stdout, stderr, status and the final data stack.

Usage: .venv/bin/python -m tests.diff_c   (builds c/bo first)
"""

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from python.bo.machine import Machine
from python.bo.values import Op

ROOT = Path(__file__).resolve().parent.parent
BINARY = ROOT / "c" / "bo"
DEFAULT_LIBRARY_PREFIX = '"include/core.bo" () INCLUDE "include/std.bo" () INCLUDE '
OP_CASES = [
    '(OP 2 3) unconsl consl',
    '"include/std.bo" require "include/stream.bo" require "include/io.bo" require 1 2 +',
    '"include/std.bo" require "include/stream.bo" include (stdin) DEPTH (stdout) DEPTH (stderr) DEPTH stdout (stdout) LOCKED',
    '"tests/reload_a.bo" include "tests/reload_b.bo" include (RELOAD-Y) SNAPSHOT (RELOAD-TMP) EXISTS (RELOAD-EMPTY) EXISTS',
    '("tests/cycle_a.bo" include) () catch',
    '"tests/cycle_c.bo" require "tests/cycle_c.bo" included "tests/cycle_d.bo" included',
    '"tests/reload_a.bo" include "tests/reload_b.bo" include 1 (RELOAD-EDIT) PUSH "tests/reload_a.bo" include (RELOAD-Y) SNAPSHOT (RELOAD-TMP) EXISTS (RELOAD-EMPTY) EXISTS',
    '"tests/reload_a.bo" include "tests/reload_b.bo" include 9 (RELOAD-Y) PUSH 1 (RELOAD-EDIT) PUSH "tests/reload_a.bo" include (RELOAD-Y) SNAPSHOT',
    '(RELOAD-USER) CLEAR "tests/reload_lock.bo" include "tests/reload_lock.bo" include (RELOAD-L) DEPTH (RELOAD-L) LOCKED',
    '(RELOAD-L) CLEAR "tests/reload_lock.bo" include 1 (RELOAD-FAIL) PUSH ("tests/reload_lock.bo" include) () catch drop (RELOAD-L) DEPTH (RELOAD-L) LOCKED (RELOAD-L) EXISTS',
    '"tests/reload_lock.bo" include 1 (RELOAD-FAIL) PUSH ("tests/reload_lock.bo" include) () catch drop (RELOAD-L) EXISTS (RELOAD-L) LOCKED',
    '("include/stream.bo" () INCLUDE) () catch',
    '"include/stream.bo" included "tests/private_basic.bo" included "tests/private_basic.bo" require "tests/private_basic.bo" included "tests/private_basic.bo" include "tests/private_basic.bo" included',
    '(1 2 OP) unconsr consr',
    '"OP" selector name (OP) name selector () name "" selector (()) name () catch',
    '(42) unittype ((1 2)) unittype (OP) unittype',
    '(OP (A B) 3) () map',
    '(1 2 3) (apply 1 + unit) map',
    '(1 2 3) 0 (apply +) foldl',
    '((1 2) (OP)) (3) append',
    '("bad name" selector) () catch',
    '"1 2 +" parse "x (y) 3.5 \\"q\\" ; c" parse "" parse',
    '"1 2 +" eval "2 3 *" eval',
    '("(1 2" parse) () catch',
    '("1\\n)" parse) () catch',
    '("\\"a\\\\q\\"" parse) () catch',
    '("1e999" parse) () catch',
    '((55296) parse) () catch',
    '(0 parse) () catch',
    '((1114112) parse) () catch',
    '("1 (" eval) () catch',
    '("tests/include_failure.bo" () INCLUDE) () catch (INCLUDE-BEFORE) DEPTH (INCLUDE-AFTER) DEPTH',
    '("tests/include_nested.bo" () INCLUDE) (drop 7) catch (NESTED-AFTER) DEPTH',
    '("tests/include_nested.bo" () INCLUDE) (rethrow) catch',
    '"tests/include_failure.bo" () INCLUDE 5',
    '("tests/include_failure.bo" require) () catch "tests/include_failure.bo" included ("tests/include_failure.bo" require) () catch (INCLUDE-BEFORE) DEPTH',
    '("tests/include_nested.bo" require) () catch "tests/include_nested.bo" included "tests/include_failure.bo" included',
    '(drop 1 (HANDLED) PUSH) (EXCEPTION) PUSH "tests/include_failure.bo" () INCLUDE (HANDLED) DEPTH (INCLUDE-AFTER) DEPTH',
    '((("tests/include_failure.bo" () INCLUDE) (drop 1) catch) (drop 2) catch)',
    '(() LOCK) () catch (() UNLOCK) () catch () LOCKED',
    '(((1 2) (2)) (1 2) ->) () catch',
    '(((1 2) (2)) (1 2) 5 <-) () catch',
    '(DROP) UNLOCK (DROP) DELETE (DROP) EXISTS (DROP) LOCKED 1 2 () DROP',
    '(ADD) UNLOCK 5 (ADD) PUSH (ADD) DELETE (ADD) EXISTS (ADD) DEPTH 1 2 () ADD',
    '(DROP) UNLOCK (DROP) DELETE () LEXICON (apply name "DROP" =) filter',
    '(0 -1 ^) () catch',
    '(-8 0.5 ^) () catch',
    '(10 1000 ^) () catch',
    '(1 0 //) () catch',
    '65 emit 32 emitc 65 emitc nl -7 emit 3.5 emit (9007199254740994 emit) () catch',
    '(1 0 /) () catch',
    '(1e308 10 *) () catch',
    '((7) (Disk-Full) throw) () catch',
    '((7) "Disk-Full" throw) () catch',
    '((7) (1) throw) () catch',
    '(("Type-Error" (DIV) () () 1) rethrow) () catch',
    '(((Type-Error) "DIV" () () 1) rethrow) () catch',
    '(1 0 /) (rethrow) catch',
    '(NOT-DEFINED) () catch',
    '"include/std.bo" require (((MISSING) EXISTS) (MISSING) (42) ifte) (guard) PUSH guard',
    '1 10 : 0 2 10 :: 0 0.1 0.3 :: 0 0.3 :',
    '3 -1 0 :: 0 0 3 :: 3 1 0 ::',
    '("x" 0.1 1 ::) () catch',
    '(0 1e-320 1 ::) () catch',
    '1 (COLON-STACK) PUSH 2 (COLON-STACK) PUSH 10 (COLON-STACK) PUSH '
    '(COLON-STACK) RANGE (COLON-STACK) POP',
    '"include/std.bo" require (1 2 3 4 5 6) (2 3) array dup shape swap rank (3 2) reshape '
    'dup (2 1) -> swap (1 2) unit unittype',
    '() (0 3) array dup shape swap rank',
    '(1 2) (2) array (TENSOR-WORK) PUSH (TENSOR-WORK) SHAPE (TENSOR-WORK) POP',
    '(1 2 3 4 5) (5) array 3 chunk concat '
    '(1 2 3 4) (4) array 2 chunk (2 (*) .) () PARALLEL concat',
    '(1 2 3 4 5 6) (2 3) array () (+) .. (7) () array () (+) .. (() (0 3) array () (+) ..) () catch',
    '(1 2 3 4 5 6) (2 3) array 0 (+) .. '
    '(1 2 3 4 5 6) (2 3) array 1 (+) ..',
    '(-2 0 3 4) (2 2) array () (*) .. '
    '(-2 0 3 4) (2 2) array () any '
    '(-2 0 3 4) (2 2) array () all '
    '(-2 0 3 4) (2 2) array () (min) .. '
    '(-2 0 3 4) (2 2) array () (max) .. '
    '(1 2 3 4 5 6) (2 3) array 0 (*) .. '
    '(1 2 3 4 5 6) (2 3) array 0 any '
    '(1 2 3 4 5 6) (2 3) array 0 all '
    '(1 2 3 4 5 6) (2 3) array 0 (min) .. '
    '(1 2 3 4 5 6) (2 3) array 0 (max) .. '
    '() (0 0) array 0 (min) ..',
    '(1 2 3) (3) array (4 5 6) (3) array dot',
    '(1 2 3 4 5 6) (2 3) array () mean '
    '(1 2 3 4 5 6) (2 3) array 0 mean '
    '(1 9 2 8 3 7) (2 3) array () median '
    '(1 9 2 8 3 7) (2 3) array 0 median '
    '(3 1 2) (3) array () median '
    '(-1e308 1e308) (2) array () median '
    '(1 2 3 4 5 6) (2 3) array transpose '
    '(1 2) (2) array (3 4 5) (3) array outer '
    '(1 2 3 4 5 6) (2 3) array (7 8 9 10 11 12) (3 2) array matmul',
    '((1 A) (2) array) () catch',
    '((1 2) (3) array) () catch',
    '(((1 2) (3)) shape) () catch',
    '(((1 2) (2)) (3) reshape) () catch',
    '(((1 2) (2)) (A) ->) () catch',
    '(1 2 3 4 5 6) (2 3) array (1 2 3 4 5 6) (2 3) array (1 2) 99 <-',
    '(1 2 3 4 5 6) (2 3) array (10 20 30) (1 3) array (+) . '
    '(1 2) (2 1) array (10 20 30) (3) array (+) . '
    '(1 2 3 4 5 6) (2 3) array 2 (*) . '
    '(1 2 3 4 5 6) (2 3) array 2 (/) .',
    '(1 2 3) (3) array 2 (^) . (7 8 9) (3) array 2 (//) . (1 2 3) (3) array (4) (1) array (-) .',
    '() (0 3) array 2 (*) . (2) () array 1 (+) .',
    '((1 2) (2) array (1 2 3) (3) array (+) .) () catch',
    '2 3 (+) . 7 2 (-) . 3 4 (*) . 8 2 (/) . 9 0.5 (^) . 7 2 (//) .',
    '(dup *) (square) PUSH (+ dup *) (sumsq) PUSH (1 2 3) (3) array (4 5 6) (3) array (sumsq) . '
    '(1 2 3) (3) array 5 (max) . (3 1 2) (3) array 2 (rem) . (1 2 3) (3) array 4 (drop) . '
    '2 3 (sumsq) .',
    '(1 2 3) (3) array 10 (+) . (drop drop 7) (+) PUSH (1 2 3) (3) array 10 (+) . (+) POP drop '
    '(1 2 3) (3) array 10 (+) .',
    '(1 2 3) (3) array (BWORK) PUSH 2 (BWORK) PUSH (-) (BWORK) PUSH (BWORK) BROADCAST (BWORK) POP',
    '((1 2) (2) array 1 (UNDEFINED-OP) .) () catch',
    '((1 2) (2) array 1 (dup) .) () catch',
    '(drop drop) (nothing) PUSH ((1 2) (2) array 1 (nothing) .) () catch',
    '(drop drop ()) (listy) PUSH ((1 2) (2) array 1 (listy) .) () catch',
    '(drop drop drop 0) (eat) PUSH 100 200 ((1 2) (2) array 1 (eat) .) () catch',
    '((1 2) (2) (+) .) () catch',
    '((1 2) (2) array (+ -) .) () catch',
    '((1 2) (2) array 1 .) () catch',
    '((1 2) (2) array 1 (ADD) .) () catch',
    '((1 2) (2) array () .) () catch',
    '((1 1) (2) array 0 (//) .) () catch',
    '((-1) (1) array 0.5 (^) .) () catch',
    '((1e308) (1) array 10 (*) .) () catch',
    '(1 2 3) (3) array (0) (1) array (/) . ',
    '() (0 3) array (1 2 3) (3) array (+) . () (0) array () () array (+) .',
    '(1 2 3) (3) array (4 5) (2) array (+) .',
    '((1 2 3) (3) array (4 5) (2) array (+) .) () catch',
    '((1 1) (2) array (1 0) (2) array (/) .) () catch',
    '(((1 2) (2)) 0 chunk) () catch',
    '(42 concat) () catch',
    '(((1e308 1e308) (2)) () (+) ..) () catch',
    '(1 2 3 4 5 6) (2 3) array 1 (-) .. (1 2 3 4 5 6) (2 3) array 0 (/) .. '
    '(2 3 2) (3) array () (^) .. (7 2 3) (3) array () (//) ..',
    '(+ dup *) (sumsq) PUSH (1 2 3 4) (4) array () (sumsq) .. (3 1 2) (3) array () (max) .. '
    '(3 1 2) (3) array () (rem) .. (3 1 2 5 6 7) (2 3) array 1 (max) ..',
    '(1 2 3) (3) array () (+) .. (drop drop 7) (+) PUSH (1 2 3) (3) array () (+) .. (+) POP drop '
    '(1 2 3) (3) array () (+) ..',
    '(1 2 3) (3) array (RWORK) PUSH () (RWORK) PUSH (+) (RWORK) PUSH (RWORK) REDUCE (RWORK) POP',
    '(drop drop) (nothing) PUSH ((1 2 3) (3) array () (nothing) ..) () catch',
    '(drop drop ()) (listy) PUSH ((1 2 3) (3) array () (listy) ..) () catch',
    '(drop drop drop 0) (eat) PUSH 100 200 ((1 2 3) (3) array () (eat) ..) () catch',
    '((1 2 3) (3) array () (UNDEFINED-OP) ..) () catch',
    '((1e308 1e308) (2) array () (+) ..) () catch',
    '(((1 2) (2)) () (+ -) ..) () catch',
    '((1 2) (2) array () (+) .. 1 (+) ..) () catch',
    '(-2 0 3) (3) array () any (-2 0 -3) (3) array () any (1 2 3) (3) array () all (1 0 3) (3) array () all '
    '(1 -2 3 4) (2 2) array 0 any (1 -2 3 4) (2 2) array 1 all',
    '((() (0)) () any) () catch ((() (0)) () all) () catch ((() (0 3)) 0 (+) ..) () catch',
    '(((1 2) (2)) (0) (+) ..) () catch',
    '(((1e308 1e308) (2)) 0 (+) ..) () catch',
    '(() (0 65536 65536) array 0 (+) ..) () catch',
    '(((1e308 1e308) (2)) () (*) ..) () catch',
    '((() (0)) () (min) ..) () catch',
    '((() (0 1)) 0 (min) ..) () catch',
    '((() (0 3)) () mean) () catch',
    '(() (0 65536 65536) array 0 mean) () catch',
    '((() (0 3)) () median) () catch',
    '((() (2 0)) 1 median) () catch',
    '(((1 2) (2)) (0) median) () catch',
    '(((1 2) (2)) transpose) () catch',
    '(((1 2) (1 2)) ((3 4) (1 2)) matmul) () catch',
    '(((1 2) (2)) ((3 4 5) (3)) dot) () catch',
    '(1 2 3 4 5) (0 0 1 1 0) mask (1 2 3 4 5) (1 1) mask () () mask (1 2 3) (0 0 0) mask '
    '((1 2) OP 3 (4)) (1 0 2 1) mask ((1 2) OP 3) (0 0 0 0 1) mask',
    '(1 2 3 4 5 6) (apply 2 mod 0 =) filter () (drop 1) filter (1 2) (drop 0) filter ((1) (2 3) (4)) (apply len 1 =) filter',
    '"puzzle.x" "puzzle." startswith "foo" "puzzle." startswith "puz" "puzzle." startswith "" "" startswith '
    '(1 2 3) (1 2 3 4) startswith ((1) 2 (3)) ((1) 2) startswith (1 OP) (1 OP) startswith',
    '"x.bo" ".bo" endswith "bo" ".bo" endswith "" "" endswith (1 2 3) () endswith (1 2 3) (2 3) endswith '
    '((1) 2 (3)) (2 (3)) endswith (1 2 3) (1 3) endswith',
    '"hello world" "o w" contains "hello world" "xyz" contains "abc" "" contains "" "a" contains '
    '"abc" "abc" contains "abc" "abcd" contains (1 (2 3) 4) ((2 3) 4) contains (1 2 3) (3 2) contains',
    '1 2 (10 +) dip 5 (dup *) keep 6 (2 *) (3 +) bi 10 1 (2 (3 +) dip) dip 0 ((1 +) 3 times) 4 times '
    '(5 (() (Boom) throw) dip) () catch 0 ((0 0 /) 3 times) () catch',
    '(1 2 3 4) sum () product (5 3 9 1 3 7) sort ((1 x) (0 y) (1 z)) (1 nth apply swap 1 nth apply swap <=) sortby '
    '(1 2 3 4) -1 rotate (1 2 1 (3) x (3) x) unique "  to be\tor\\n" () strsplit (0 1 2 0 3) (apply 0 >) partition '
    '16 sqrt (-1 sqrt) () catch (1 2) (2) array (1 2 3) (3) array (-) table',
    '(N) incr (N) incr N 1 (E) PUSH 7 (E) PUSH (E) incr (E) SNAPSHOT "hi" (S) set ((S) incr) () catch (S) SNAPSHOT',
    '0 (1 2 3) (apply +) foreach 10 (1 2 3) (apply over + unit) map 3 (1 5 2 8) (apply over >) filter '
    '5 (9 1 6 4) (2 pick - abs swap 2 pick - abs swap <=) sortby 2 () 1 (dup 10 >) (over *) unfoldr '
    '((1 2) (() (Boom) throw) map) () catch',
    '"a,,b," "," strsplit "a--b" "--" strsplit "" "," strsplit ("to" "be") ", " strjoin () "," strjoin',
    '1 (zz-b) PUSH 2 (zz-a) PUSH 3 (zz-c) PUSH (zz-c) CLEAR () LEXICON (apply name "zz-" startswith) filter',
    '1 (zz-B) PUSH 1 (zz-_) PUSH 1 (zz-a) PUSH 1 (zz-aa) PUSH () LEXICON (apply name "zz-" startswith) filter',
    '7 1 (zz-q) PUSH (zz-box) LEXICON (zz-box) POP (apply name "zz-" startswith) filter',
    '1 (zz-x) PUSH 2 (zz-y) PUSH 3 (other) PUSH () LEXICON (apply name "zz-" startswith) filter (apply CLEAR) foreach '
    '(zz-x) DEPTH (zz-y) DEPTH (other) DEPTH',
    '5 ((dup 0 =) (drop 1) (dup 1 - (f) REC *) ifte) (f) LAMBDA 5 ((dup 0 =) (drop 1) (dup 1 - rec *) ifte) lambda',
    '((f) REC) () catch (() ((f) REC) (g) LAMBDA) () catch',
    '(5 (x) LAMBDA) () catch (() (1) LAMBDA) () catch (() "ab" LAMBDA) () catch (() ((x y)) LAMBDA) () catch '
    '((1 2) REC) () catch (() 5 REC) () catch',
    '((UNDEFINED-OP) (a) LAMBDA) () catch ((a) REC) () catch (3 (a) LAMBDA) () catch',
    '3 ((dup 0 =) (drop) (dup (zz-seen) PUSH 1 - (((a) REC) apply) (b) LAMBDA) ifte) (a) LAMBDA (zz-seen) SNAPSHOT',
    '3 ((dup 0 =) (drop) (dup (zz-seen) PUSH 1 - (rec) apply) ifte) lambda '
    '2 ((dup 0 =) (drop) (dup (zz-seen) PUSH 1 - (((x) REC) apply) (y) LAMBDA) ifte) (x) LAMBDA (zz-seen) SNAPSHOT',
    '1000 ((dup 0 =) (drop) (1 - (z) REC) ifte) (z) LAMBDA 1000 ((dup 0 =) (drop) (1 - (z) REC) ifte) (z) LAMBDA',
    '"tests/private_basic.bo" () INCLUDE (__square) EXISTS (__fact) EXISTS 3 sq1 3 fsq',
    '"tests/private_basic.bo" () INCLUDE "tests/private_basic.bo" () INCLUDE 3 sq1 () LEXICON len',
    '"tests/private_basic.bo" () INCLUDE (sq1) TOP unconsl (__square) = swap drop',
    '"tests/private_basic.bo" () INCLUDE (sq1) TOP unconsl name swap drop (__square) name =',
    '"tests/private_basic.bo" () INCLUDE (sq1) TOP unconsl name selector swap drop (sq1) TOP unconsl drop =',
    '"tests/private_basic.bo" () INCLUDE (2 __square) () catch (__square) TOP',
    '"tests/private_basic.bo" () INCLUDE (2 __square) apply',
    '(1 +) (__inc) PUSH 2 __inc (__inc) EXISTS',
    '0 ((dup 50000 <) (dup unit drop 1 + rec) () ifte) lambda 0 ((dup 50000 <) (dup unit drop 1 + (r) REC) () ifte) (r) LAMBDA',
    '0 ((dup 3 <) (1 + ((x) REC) (i) LAMBDA) () ifte) (x) LAMBDA 0 ((dup 3 <) (1 + (rec) apply) () ifte) lambda',
    '(0 ((dup 3 <) (1 + (a) 1 + rec) () ifte) lambda) () catch (0 ((dup 3 <) (1 + rec) () ifte) (x) LAMBDA) () catch',
    '0 ((dup 3 <) (1 + rec 10 +) () ifte) lambda 0 ((dup 3 <) (1 + (r) REC 10 +) () ifte) (r) LAMBDA',
    '0 (dup 5 <) (1 +) loop 0 (dup 5 <) (1 +) () LOOP 7 (dup 5 <) (1 +) loop 9 (0) (1 +) loop',
    '0 (dup 50000 <) (dup unit drop 1 +) loop 0 (dup 50000 <) (dup unit drop 1 +) () LOOP',
    '0 0 (dup 4 <) (1 + 0 (dup 3 <) (1 +) loop + swap 1 + swap) loop',
    '(((a)) (1) loop) () catch',
    '(((a)) (1) () LOOP) () catch',
    '(1 (1) loop) () catch',
    '(loop) () catch',
    '(() LOOP) () catch',
    '(() (1) loop) () catch',
    '(() (1) () LOOP) () catch',
    '(0 (dup 3 <) (1 + (a) 1 +) loop) () catch (0 (dup 3 <) (1 + (a) 1 +) () LOOP) () catch',
    '(0 ((dup 3 <) 1 +) loop 5) () catch (() (1 drop 0) loop) () catch',
    '0 (dup 3 <) (1 + rec) loop',
    '0 ((dup 3 <) (1 + (dup 0 >) (rec drop 0) loop) () ifte) lambda 0 ((dup 3 <) (1 + (dup 0 >) (rec drop 0) () LOOP) () ifte) lambda',
    '4 (((dup 0 >) (1 - rec) () ifte) lambda) () catch 0 (dup 3 <) (1 + (zz-seen) PUSH) loop (zz-seen) SNAPSHOT',
    '(0 (dup 3 <) (dup 2 = (UNDEFINED-OP) () ifte 1 +) loop) () catch',
    '0 (dup 3 <) (1 + (() (dup 2 =) (loop) () ifte) drop) loop',
    '(2 (dup 0 >) (1 -) loop) (go) PUSH go 3 go (go) EXISTS',
    '(0 (dup 3 <) (1 +) loop) (zz-a) PUSH zz-a (0 (dup 5 <) (1 +) ((dup 3 <) (2 +) loop)) (loop) PUSH zz-a (loop) POP',
    # debugging: no pause outside a prompt, errors for the resume commands, backtrace and where
    '1 @ 2 3 + (7) () BREAKPOINT',
    '(step) () catch (next) () catch (continue) () catch (stop) () catch (() STEP) () catch',
    '"a" 2 watch 7 8 9 "after" 2 watch "none" 0 watch "all" 10 watch ("x" (a) watch) () catch drop stdout',
    '(1 backtrace 2) (inner) PUSH (inner 3) (outer) PUSH outer',
    '(0 backtrace) (inner) PUSH (inner 3) (outer) PUSH (outer 4 5) (top) PUSH top',
    '(1 where 2) (f) PUSH (f 3) (g) PUSH g',
    '(1 where) (f) PUSH f',
    '1 @if 0 @if (7) () @if 2',
    'break-on-error 7 (1 0 /) apply 9',
    'break-on-error break-on-error (EXCEPTION) DEPTH break-off-error (EXCEPTION) DEPTH break-off-error',
    '(drop 1) (EXCEPTION) PUSH break-on-error (EXCEPTION) DEPTH break-off-error (EXCEPTION) DEPTH',
    'break-on-error (drop 2) (EXCEPTION) PUSH break-off-error (EXCEPTION) DEPTH',
    '((dup 2 <) () (dup 1 - fib swap 2 - fib +) ifte) (fib) PUSH (fib) 1 trace 4 fib (fib) untrace 4 fib',
    '(1 +) (succ) PUSH (succ succ) (twice) PUSH (twice) 2 trace (succ) 0 trace 10 20 twice '
    '(succ) 1 trace (twice) untrace 5 twice (succ) untrace 5 twice',
    '(1 0 /) (bad) PUSH (bad) 1 trace (bad) () catch (bad) untrace (bad) () catch',
    '5 (k) PUSH (k) 1 trace k (k) untrace k (NOT-TRACED) untrace',
]


def dump(value):
    if isinstance(value, Op):
        return value.name
    if isinstance(value, list):
        return "(" + " ".join(dump(x) for x in value) + ")"
    if value != value:
        return "@"
    return "%.17g" % value


def collect():
    """Run the unit tests and record each snippet passed to Machine.execute."""
    snippets = []
    original = Machine.execute

    def spy(self, text, source="stdin", first_line=1, file=False):
        if source == "stdin" and first_line == 1 and text not in snippets:
            snippets.append(text)
        return original(self, text, source, first_line, file)

    Machine.execute = spy
    try:
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
        results = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = unittest.TextTestRunner(stream=results).run(suite)
        if not result.wasSuccessful():
            raise RuntimeError(f"Cannot collect differential snippets: test suite failed\n{results.getvalue()}")
    finally:
        Machine.execute = original
    return snippets


def python_run(code):
    machine = Machine()
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            ok = machine.execute(code)
        except SystemExit:
            ok = True
    return ok, out.getvalue(), err.getvalue(), " ".join(dump(x) for x in machine.data)


def c_run(code):
    with tempfile.NamedTemporaryFile("r", suffix=".dump") as dump_file:
        proc = subprocess.run(
            [str(BINARY), "--bare", "--dump", dump_file.name, "-e", code],
            capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
        )
        stack = dump_file.read().rstrip("\n")
    return proc.returncode == 0, proc.stdout, proc.stderr, stack


def main():
    subprocess.run(["make", "-s", "-C", str(ROOT / "c")], check=True)
    snippets = list(dict.fromkeys(collect() + [
        DEFAULT_LIBRARY_PREFIX + code for code in OP_CASES
    ]))
    failures = 0
    for code in snippets:
        expected, actual = python_run(code), c_run(code)
        if expected != actual:
            failures += 1
            print("MISMATCH:", repr(code))
            for label, a, b in zip(("ok", "stdout", "stderr", "stack"), expected, actual):
                if a != b:
                    print(f"  {label}\n    py: {a!r}\n    c:  {b!r}")
    print(f"{len(snippets)} snippets, {failures} mismatches")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
