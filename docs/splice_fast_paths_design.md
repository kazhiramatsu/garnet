# Splice whose result is discarded

## Problem

`arr.splice(start, deleteCount, ...items)` was lowered uniformly: the
exporter built an items array, and the runtime allocated the array of
removed elements and rebuilt the whole element buffer (`malloc`, copy,
free), even for the checker's sorted insertion `typeSet.splice(~index, 0,
type)` — 352k calls per compile whose result nobody reads — and for
`result.splice(spliceIndex, 0, flags)` (63k). Three allocations and an
O(n) rebuild per insertion; 415k discarded result arrays per compile in
the per-site statistics of `native_s350x17`.

## Design

The exporter knows when a call is an expression statement, i.e. its
result is discarded:

- `a.splice(i, 0, x)` — exactly three arguments, the literal `0` as the
  delete count, no spread — lowers to `array.spliceInsert1(i, x)`: the
  runtime grows the buffer like `push`, shifts the tail with `memmove`,
  stores the element, invalidates the dirty-card range and runs the write
  barrier for the stored element. No items array, no removed array, no
  rebuilt buffer. Negative, out-of-range and fractional indices are
  clamped exactly as the general splice clamps them; a fixed-storage
  (Uint16-like) array takes the general path, which coerces; a frozen
  array throws the TypeError that `push` throws (the general splice used
  to leave a frozen array alone — V8 throws in strict code, so every
  splice entry now throws through `ts_array_set`).
- Any other discarded splice lowers to `array.spliceDrop`, the general
  splice without the removed array (the shared implementation takes a
  `want_removed` flag).

Splices whose result is used are unchanged. `TSAOT_SPLICE_FAST=0`
(exporter) keeps the general builtin for every splice; the parity oracle's
corpus is exported with it.

## Verification

Fixture `arrays/splice_fast_paths`: single inserts at every kind of index
(0, inside, at the end, negative, far negative, far positive, fractional,
NaN) into empty, inline-backed and heap-backed arrays; 20k sorted
insertions of objects with collections between them; the discarded
general forms (delete, replace, insert several, delete to end, spread
items); holes shifting; the result-using forms; a frozen receiver; a
fixed-storage array. The per-site statistics (result arrays per compile)
and the compiler A/B.
