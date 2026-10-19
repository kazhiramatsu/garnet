# String + integer without the intermediate string

## Problem

The checker's caches are keyed by strings built from type ids:
`getTypeListId` appends `result += startId` (and `":" + count`) per type
of a union or intersection, `getRelationKey` builds
`` `${sourceId},${targetId}${postFix}` ``, `getFlowCacheKey`,
`createModeAwareCacheKey` and `addTypesToIntersection` do the same. The
profile of `native_s350x19` put a third of its string time there: `ts_add`
(78 samples, 58 of them in `getTypeListId`), `ts_fmt_num` (20),
`ts_str_concat_many` (23, 21 in `getRelationKey`), `ts_new_string` (15).
Every `string + number` first materialized the number as a string cell
(`ts_to_string_v`: format, allocate), then concatenated into a second
cell; a template literal with two ids allocated two number strings before
the result. The checker performs 1.5M such concatenations per compile.

## Design

- `ts_add` with a string and an *integer* number (|n| < 9e15, integral,
  `-0` included) formats the digits on the stack (`ts_i64_to_str`) and
  concatenates them with the string directly: an immediate short string
  when the result has at most five ASCII characters, otherwise one
  allocation of the result with the string's units and the digits copied
  in. Results at or above the builder threshold (24 code units) keep the
  general path, so the append history of long keys is unchanged. The
  string operand may be a flat, UTF-16 or view string; its view is
  re-fetched after the allocation because the cell may move.
- `ts_str_concat_many` (template literals) formats integer parts into
  per-part stack buffers and reads them through a stack view in every
  branch (immediate, extend, builder, flat); a template whose first part
  is an integer never takes the "extend the first part" branch, and a
  template with more than sixteen parts keeps the old materialization.
- `ts_strict_eq`: two immediate short strings with different bits are
  different strings (the immediate encoding is canonical), so the
  out-of-line comparison is skipped for them — `switch` on identifier
  names and `name === "this"` tests.

No new knobs: the semantics are unchanged (the digits are the ones
`ts_fmt_num` produces), and the parity oracle does not see the runtime.

## Verification

Fixture `strings/concat_fast_paths` (every prefix length class — empty,
immediate, flat, builder-sized, UTF-16, a view — against integers of every
kind: zero and minus zero, negatives, the 2^53 boundary, 1e15/9e15/1e16,
1e21, fractions, NaN, infinities; `s + n`, `n + s`, templates with the
number first, last and repeated; keys compared with literals and used as
Map keys; a `switch` over short and long literal names; 30k keys built
under collection pressure), a hash of every result checked against V8.
Kernel `benchmarks/patterns/string_keys.ts`: native 230 → 198 ms against
Node 137 ms (1.67x → 1.46x). The compiler A/B.
