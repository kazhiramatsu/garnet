# Inline fast paths: strict equality, ToInt32, truthiness

Implemented in Session 350 (slice `x25`); runtime only (`runtime/ts_rt.h`,
`runtime/ts_rt.c`, allowlist of `tests/runtime_inline_policy_gate.sh`).

## Finding

The `native_s350x24` profile (2,783 samples) had `ts_strict_eq` at 114
samples (4.1%), up from 20 in `x22`: the `static inline` helper grew with
the `x23` length check, and clang's inliner, whose budget a generated
function of several thousand lines exhausts, emitted an out-of-line copy
and a call at most `===` sites. `ts_to_int32` (19 samples) and
`ts_truthy_fast` (22) were outlined the same way: both carry a rarely
executed tail (the `floor`/`fmod` reduction, the string length test) that
makes the whole helper too large to inline.

The callers were the checker's hottest functions: `isSimpleTypeRelatedTo`,
`isTypeRelatedTo`, `compareValues`, `findAncestor` (object identity), and
`getCannotFindNameDiagnosticForName`, `isThisIdentifier` (strings).

## Change

1. `ts_strict_eq` is `TS_RT_ALWAYS_INLINE` and bounded: same bits, two
   numbers, then object identity (`ts_same_cell`, the checker's common
   case, now before the string tests), then two strings out of line through
   `ts_strict_eq_str`, which keeps the `x23` length check before any view
   is built and then calls `ts_strict_eq_slow`.
2. `ts_to_int32` / `ts_to_uint32` keep only the exact-range conversion in
   line (always inline) and call `ts_to_int32_slow` / `ts_to_uint32_slow`
   for NaN, infinities and values outside the range.
3. `ts_truthy_fast` is always inline (its body was already bounded; the
   string case was already out of line).
4. The inline policy gate's allowlist of always-inline helpers gains the
   four names: they are bounded fast paths in the sense of that gate.

## Verification

Fixture `operators/bitwise_int32_edges` (every bitwise operator and the
unsigned shift over exact, fractional, out-of-range, huge, NaN, infinite
and negative-zero operands; strict equality over objects, functions,
strings of equal and different content, numbers, NaN, signed zero,
booleans, nullish values and arrays; identity compares under collection
pressure), identical to V8. Profile of `x25`: the three helpers no longer appear as symbols
(`ts_strict_eq_str` 26 samples, `ts_strict_eq_slow` 15 → 5); the callers
absorbed the inlined compares. Compiler A/B against `x24`, two runs of
three alternating pairs: 5.653 → 5.637 s and 5.800 → 5.746 s median wall
(−0.3% and −0.9%), Node 3.26–3.36 s.
