# What the generated C tells the C compiler

garnet emits C and leaves instruction selection, register allocation, inlining and layout to the C
compiler. That compiler can only use what the C says. This document lists what generated code and the
runtime's header say on purpose, what each statement bought, and what was tried and not kept. It
complements the analyzer's own proofs (docs/int32_fields_design.md and the others): a proof removes a
test; this is about the tests and calls that stay.

## The setting

- A program is built as units of ThinLTO bitcode; **the runtime (`ts_rt.c`) is a native object beside
  them**. A call from generated code into the runtime is opaque: the declaration in `ts_rt.h` is all
  the C compiler knows of the function. Only the `static inline` helpers of the header are seen whole.
- Generated code tests in line and calls a slow half out of line: a typed field access tests its
  receiver and calls the generic read, a store tests the frozen bit and calls a throw, a pointer store
  tests the owner's generation and calls the remembered set, an element read tests the capacity and
  calls the keyed read. A hot function has dozens of such calls that never run.
- Where the checkers of tsc-ts spend their samples (Session 367): 14% on the instructions that set up
  and tear down frames. A call the C compiler takes to come back makes every value that is live after
  it sit in a callee-saved register, and the function saves and restores those registers at every
  call of it, whether or not the slow half runs.

## What is said

### A function that throws does not return (`TS_RT_NORETURN`)

`ts_throw` leaves by `longjmp` or ends the process. The helpers that format a message and throw it
were declared as ordinary functions: `ts_throw_frozen_field` at every store to a class field,
`ts_throw_uninitialized` at every read of a binding that may be in its dead zone, the receiver checks
of a dynamic call (`ts_check_method_recv_slow`, `ts_dynamic_method_missing`), the error constructors
by message. Declared `noreturn, cold`, the C compiler keeps nothing alive across them, writes no code
that goes on from them and lays their blocks out of line.

Rule: a runtime function every path of which ends in a throw is declared `TS_RT_NORETURN`. A function
that throws on some paths is not.

### The slow half of an inline test keeps the caller's registers (`TS_RT_SLOW_CALL`, `TS_RT_COLD_CALL`)

`preserve_most`: the callee preserves every general register but the arguments' and the result's
(x0 to x8, x16 to x18 on AArch64), so the caller holds its live values in caller-saved registers
across the call and only the slow half pays, when it runs, for what it uses. `noinline` keeps the
half out of line. On the declarations of:

- the write barrier's remembered set (`ts_gc_remember`, `ts_gc_remember_slot`, `ts_array_remember`),
- an element read past the capacity or off a receiver that is no array (`ts_array_get_key_i64`,
  `ts_array_get_key_f64`), a hole under a prototype element (`ts_array_hole_read`),
- a length of a receiver that is no array (`ts_array_len_foreign`, `ts_length_slow`),
  `ts_array_is_array_slow`, a `for..of` source that is no array (`ts_forof_array_source_slow`),
- a number that is none (`ts_number_coerce_slow`),
- `ts_get_checked_cold`, `ts_get_cold`, `ts_set_cold`: the generic read and store under this
  convention, for the failing side of a typed field access's guard (the functions they wrap stay
  as they are for dynamic code, where they are the path taken).

`TS_RT_COLD_CALL` is the same with `cold` for a half that is the failing side of a guard.

Rules:
- **Every declaration of such a function carries the attribute**: the convention is part of the call,
  and a caller that does not see it corrupts registers silently. They are declared once, in `ts_rt.h`.
- Floating point registers follow the ordinary convention: a double live across such a call still
  takes a callee-saved register.
- A half that generated code takes often is no candidate: the callee saves more than it would.

### The failing side of a guard is an unlikely branch

A typed field read is `TS_RT_UNLIKELY(guard) ? ts_get_checked_cold(o, k) : ((C*)ts_ptr(o))->f`. The
guard had no hint, and a test of a tag against a constant is an even bet to the C compiler: the slow
side was laid out and weighed as half of the executions.

### A typed store's two failing sides, apart

```c
if (TS_RT_UNLIKELY(guard)) { ts_set_cold(o, k, v); } else
if (TS_RT_UNLIKELY(ts_store_frozen(o))) { ts_throw_frozen_field(o, k); } else
{ ((C*)ts_ptr(o))->f = v; }
```

A receiver that is not the struct takes the generic store, which answers for whatever it is; then a
frozen instance throws. They were one condition (`guard || frozen`) whose slow block read the frozen
bit again to tell the two apart, off a receiver that could be `undefined`: a store through a function
value with an `undefined` receiver, in a program that freezes instances of the class, faulted where V8
throws a TypeError (a direct call with a constant receiver was folded and hid it). Fixture
`classes/frozen_store_foreign_receiver`.

### No call in a truthiness test

`ts_truthy_fast` answered for numbers, objects, functions, booleans, `undefined` and `null` in line and
called `ts_truthy` for a string. A string's truthiness is its length, a load: it is in line now, and a
test of a value typed `boolean` (whose slot may hold anything) is no call site.

### Raw boolean returns of recursive predicates

Not a statement to the C compiler but found on the same pass over the generated C: a direct entry
returns a raw `int` when every return holds booleans produced in place or the results of entries that
do (`bool_return_locals`). The set was grown from nothing, so a predicate that returns its own call
(`isMatchingReference`), or two that call each other, never joined it and returned a boxed boolean
that every caller tested by tag. It is the greatest fixed point now (every eligible function assumed,
dropped when its returns do not hold under the assumption; sound by induction on the returns of an
execution), and the signatures are computed once after it where they were computed once a round.
`TSAOT_BOOL_RETURNS_REC=0` keeps the least fixed point.

## Measured (tsc-ts, the TypeScript 6.0.3 compiler project, instructions)

| build | one thread | a default run's processes |
|---|---|---|
| r44 (before) | 12.788 G | 15.693 G |
| throws do not return | 12.729 G (-0.46%) | -1.39% |
| and the slow halves, the hints, the store, truthiness | 12.610 G (-1.39%) | -3.09% |
| and the raw boolean returns (2,212 -> 2,296 entries) | 12.600 G (-1.47%) | -2.98% |

One thread repeats within 0.05%. A default run's total moves by up to 1% between two measurements of
one binary (which fork takes which statements), so the second column is a direction, not a figure.

The shape of one function, `Scanner.scan` (its unit compiled alone): 374 instructions and six saved
register pairs; 288 with the throws declared; 269 and three pairs with three of its slow halves under
`preserve_most`. `getCombinedNodeFlags`, whose eleven call sites are all slow halves: three saved
pairs to one.

## Tried and not kept

- **Hot/cold splitting under ThinLTO** (`-Wl,-mllvm,-hot-cold-split=true`; Apple clang runs the pass
  for native objects, which is where the runtime's `.cold.N` parts come from, and not in the ThinLTO
  link): 20,529 parts outlined from generated functions, the binary 2.1 MB larger, **+1.24%**
  instructions on one thread. A region that ends in a throw is outlined with the work before it, and
  the call of the outlined part passes what it needs.
- **LLVM's partial inliner** (`-mllvm -enable-partial-inlining`, the same to the link): the bodies of
  396 functions outlined behind their leading test, -0.34% on one thread, a default run within its
  noise. Not switched on: what it finds is what "An entry without a frame" below does on purpose.
- **`preserve_all`** in place of `preserve_most`: the same code for the function looked at.
- A scanner entry split by hand into a dispatcher and the full scan (tsc-ts, `exp/scan-dispatch`):
  +0.32%, because the dispatcher's own slow halves gave it a frame. To be measured again on this base.

## Next

- **An entry without a frame**, as two C functions: the leading part of a function that changes
  nothing (loads, tests, returns) under the function's name, every path that would call or store
  leaving by `return f_rest(args)`, a call in tail position; `f_rest` is the function as it is. 14% of
  the samples are frame instructions and 4 to 8% of all samples are the frames of functions that have
  such a return (`build/s367/entrypot.py`). The failing side of a guard in the entry must leave, not
  run the generic read: `f_rest` would run it again.
- **`pure` on what the analyzer proves pure and total**: the C compiler reloads every field after an
  opaque call. A function that can throw is not pure to it (a call whose result is unused may be
  deleted), so this waits for receivers that need no guard.
- The runtime as bitcode in the link, so that the header's statements are inferred instead of written:
  it is one translation unit of 29 K lines, and the link would compile it again for every program.
