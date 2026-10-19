# Strings, second round: equality, literals, builder digits, view hashes

Implemented in Session 350 (slice `x23`); runtime only (`runtime/ts_rt.c`,
`runtime/ts_rt.h`). Five independent fast paths, each chosen from the
`native_s350x22` profile (3,265 samples).

## Findings

- `getCannotFindNameDiagnosticForName` (a `switch` over about thirty
  string labels, evaluated eagerly for every identifier that `resolveName`
  checks) spent 15 samples in `ts_strict_eq_slow`, 9 in `ts_strict_eq` and
  9 in `ts_heap_ref_value`: every label compare went out of line, and
  every reference to a string literal went out of line too.
- `ts_heap_ref_value` had 34 samples in all: the boxing of a static
  literal (`ts_str_v(&TS_STRLIT_n)`) takes the slow path of
  `ts_heap_ref_fast` because a static cell is neither old nor handled.
- `getTypeListId` (`result += startId`, the union/intersection cache key)
  had 91 samples under `ts_add`, 15 of them in `ts_to_string_v`: results at
  or above the builder threshold (24 code units) took the general path,
  which materializes the number as a temporary string before appending.
- `ts_str_hash_of` had 42 samples; a view (substring, builder result) never
  cached its hash, so a view used as a Map key was hashed on every lookup.
- `ts_relational` had 16 samples from `compareValues` /
  `compareComparableValues`, whose union-typed operands take the generic
  comparison; it rooted both operands and tested them for objects before
  looking at two numbers.

## Changes

1. `ts_heap_ref_fast` boxes a `TS_GEN_NONHEAP` cell in line (address with
   the stack tag), after the old-cell and handle checks, so the hot young
   path is unchanged and static literals and stack cells no longer call
   `ts_heap_ref_value`.
2. `ts_strict_eq` compares the lengths of two strings in line before the
   out-of-line compare: different lengths are different strings. Equal
   lengths still go to `ts_strict_eq_slow` (hash shortcut, then bytes).
3. `ts_add` for `string + integer` (and `integer + string`) at builder size
   writes the digits straight into the builder: in place when the string is
   the live tail of its buffer, else into a fresh builder
   (`ts_add_str_digits_builder`). No temporary number string. Results below
   the threshold keep the `x20` flat/immediate path; non-integers and
   integers beyond 2^53 keep the general path.
4. `ts_str_hash_of` caches the hash of a view in the view cell (a view's
   content never changes: a builder only extends beyond its views, and the
   view slow path carries the cell's hash and flags into the strview). A
   view of an immediate parent stays uncached because that strview's hash
   field holds the fifth byte.
5. `ts_relational` tests two numbers first (no rooting, no ToPrimitive;
   NaN compares false through the C comparison).

## Verification

Fixture `strings/equality_builders`: equality of short, flat, view and
non-ASCII strings of equal and different lengths, a string `switch`,
`string + integer` at the threshold and beyond (in-place extension, a saved
prefix view staying intact, two appends from the same prefix, negative,
fractional, huge and special numbers, `integer + string`, UTF-16 strings),
view keys in a Map, relational comparison over numbers with NaN and signed
zero and over mixed values, literals under collection pressure. Identical
to V8, also under `TSAOT_GC_YOUNG_THRESHOLD=1`.

## Results

Statistics relink (`x23`): root pushes 49.0M → 32.7M per compile (the
relational fast path no longer roots two numbers), GC pause 598 → 492 ms,
allocations unchanged (the temporary number strings were immediates).
Compiler A/B against `x22`, alternating three runs, outputs validated,
diagnostics zero: 5.790 → 5.696 s median wall (−1.6%, all three pairs
agree), Node 3.25 s.
