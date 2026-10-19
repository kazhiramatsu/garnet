# Sparse element storage for far stores (design notes, not implemented)

## Problem

The checker caches flow types in `flowTypeCache[getNodeId(node)]`, and two
callers (`checkExpressionWithContextualType`, `getTypeOfExpression`'s
own invocation-count window) set `flowTypeCache = undefined` for a window
and recreate it as `[]` on the next cached store. A store at node id
three million into a fresh array makes the dense representation fill
three million holes (24 MB of `memset_pattern16`) and grow its buffer to
match, about sixty times per compile: 107 of the 2,959 samples of the
`native_s350x19` profile (3.6%), in `ts_array_set` and the fill. V8
switches such an array to dictionary elements and the store costs a hash
insert.

## Constraints

- The inline element read is `i < a->len ? data[i] : out of line`
  (`ts_array_get_inline`), `a->len` is also the JS `length`, and every
  runtime loop over an array walks `data[0..len)`. Any representation in
  which `len` exceeds the materialized prefix must keep those readers
  safe without a new branch on the hot path.
- Holes already exist (`TS_ARRAY_HOLE`), and the minor collector scans
  `data[0..len)` with dirty cards.

## Candidate design

1. Invariant "every slot in `[len, cap)` is a hole": `array_ensure_cap`
   fills the grown tail, truncation (`length = n`, `pop`, `shift`, splice
   deletions, the splice rebuild) refills what it vacates. The inline read
   can then bound by `cap` instead of `len` at no extra cost: a dense read
   beyond `len` sees a hole (undefined, as today), and the out-of-line
   reader handles `i >= cap`.
2. A far store (`i >= cap` and far beyond `2*cap`) switches the array to
   *sparse*: `len` becomes the JS length (`i + 1`), the dense prefix stays
   `[0, cap)`, and the elements at or beyond `cap` live in a side hash of
   `uint32_t index -> tsv` reachable from a new pointer field of
   `ts_array` (the collector scans it; sparse stores remember the whole
   cell). Reads at `i >= cap` go out of line to the side hash; writes at
   `i < cap` stay dense.
3. Every generic operation (iteration, `join`, `indexOf`, `slice`,
   `splice`, `sort`, `concat`, spread, the callback builtins, JSON,
   `Object.keys`, enumeration) first *densifies* a sparse array —
   allocating `len` slots, filling holes, moving the side entries in — so
   the existing loops stay correct and the cost is paid only when such an
   array is actually iterated, which the flow cache never is. The audit
   is "one densify call at the top of each generic operation"; a missed
   one would read `data` beyond `cap`, so the audit must be complete
   (grep every `->len` reader in the array code) and the fixture must
   iterate sparse arrays through every operation.

## Verification plan

Fixture `arrays/sparse_far_stores`: far stores on empty, inline-backed and
heap-backed arrays, reads before and after densification, `length`,
`push` after a far store, holes, `in`, `delete`, every builtin on a sparse
array compared with V8, GC stress with young values in the side hash; the
compiler A/B (the flow cache pattern) and the per-site statistics.
