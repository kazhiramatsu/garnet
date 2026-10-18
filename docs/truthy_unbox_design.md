# Condition temporaries kept raw

## Problem

The exporter lowers `if (a && b)` to `t = a; if (t) t = b; if (t) ...` and
`!x` to a temporary; both are boolean-typed, and the exporter classifies
booleans as `reference` (the `primitive` kind means "a raw C double", which a
boolean is not). So every such temporary lived in a rooted frame slot, was
boxed with `ts_bool` or `ts_num`, and was tested with `ts_truthy_fast` (a
tag dispatch) at the `if`. The flags/optional-chaining kernel spent a third
of its time there; the compiler is full of `if (flags & X && !(flags & Y))`.

The emitter already kept a *comparison* result raw when every use of it was
a condition (`cmp_truthy_only`); a copy into a merge temporary counted as a
non-condition use, so the `&&`/`||` forms and the `!` results never
qualified.

## Rule (`truthy_only_unbox` in `emit_c.rs`)

A local is kept raw (an unboxed numeric local, 0/1 or the copied number)
when

- every definition is a comparison, a `!`, or a copy of a raw numeric local
  or of another local kept raw by this rule, and
- every use is an `if`/loop condition, a `!` operand, or a copy into another
  local kept raw by this rule, and it is used at least once.

The two conditions form a fixpoint: a local that stays boxed disqualifies
the raw locals copied into it (a raw 0/1 must never be boxed as a number,
`console.log(a < b)` prints `true`). A conditionally assigned flag
(`let ok; if (c) ok = a < b; if (ok)`) reads as 0 on the path without a
definition, which is falsy exactly as `undefined` is. The decision is made
against the final numeric set of the function, after the nullable and
maybe-undefined removals, so a copy source is never raw while its target is
boxed. `TSAOT_TRUTHY_UNBOX=0` keeps the comparison-only rule (parity oracle).

Fixture `operators/condition_temps` (conditions with `&&`/`||`/`!`/`!!`,
strings and NaN operands, conditionally assigned flags) and the same
expressions used as values (which must stay booleans, numbers or
undefined).
