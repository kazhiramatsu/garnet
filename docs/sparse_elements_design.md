# Sparse element storage for far stores

Implemented in Session 350 (slice `x22`); runtime only (`runtime/ts_rt.c`,
`runtime/ts_rt.h`). Kill switch: `TSAOT_SPARSE_ELEMENTS=0` (runtime
environment) keeps every array dense.

## Problem

The checker caches flow types in `flowTypeCache[getNodeId(node)]`, and
`checkExpressionWithContextualType` clears the cache for a window, so the
next cached store recreates it as `[]`. A store at node id three million
into a fresh array made the dense representation fill three million holes
(24 MB of `memset_pattern16`) and grow its buffer to match, about sixty
times per compile: 107 of the 2,959 samples of the `native_s350x19` profile
(3.6%), in `ts_array_set` and the fill. V8 switches such an array to
dictionary elements and the store costs a hash insert.

## Design

Two parts: an invariant on dense arrays that frees the inline reader from
the length, and a sparse form that owns no dense buffer.

### Hole invariant

Every slot in `[len, cap)` of a dense array holds `TS_ARRAY_HOLE`.
Maintained by `array_init_storage` (fills `[0, cap)`), `array_ensure_cap`
(fills the grown tail), `ts_array_set_length` (refills what a truncation
vacates), `pop`, `shift`, the splice rebuild (exact capacity, or the inline
buffer refilled) and the single-element splice insert (a memmove inside
the invariant). Before, the grown tail and truncated slots held stale
values that only the length kept unreachable.

Consequences: the inline element readers (`ts_array_get_inline`,
`ts_array_get_inline_lazy`) bound by `cap` instead of `len` (the same
8-byte word, no extra cost), and `ts_array_set` no longer fills holes
between the length and the index (the loop is gone; the grow path is out of
line).

### Sparse form

`ts_array.sparse` (a byte of the former padding; the struct stays 128
bytes) marks an array whose elements live in a side table: `len` is the JS
length, `cap` is 0 and `data` is NULL, so every reader bounded by `cap`
sees no dense slot and a reader that forgets to densify faults loudly
instead of reading garbage. The table pointer lives in `inline_data[0]`
(copied with the cell by the moving collector; no fix-up since `data` is
NULL). The table (`ts_sparse_elems`) is open addressing with linear
probing: `uint32_t` keys (`0xFFFFFFFF` = empty; 2^32-1 is never an element
index), `tsv` values after the keys in one allocation, load factor 1/2,
tombstones (hole values) for `delete`, `pop` and truncation.

Transitions:

- dense → sparse on a store at `i` with `i >= cap + 1024` and `i >= 2*cap`
  (`array_store_is_far`; V8's dictionary-elements rule in spirit), and on
  `length = n` by the same rule. The dense elements move into the table.
- sparse → dense (`array_densify`: holes everywhere the table has no
  entry) when a store makes `count * 8 >= len` (V8's fast-elements
  heuristic), when the dense buffer must grow (`array_ensure_cap`: push
  of a hole, splice insert, JSON parse), and at the top of every generic
  operation (`as_arr` for a maybe-array, `arr_dense` for a known array): the
  callback builtins, `join`, `indexOf`, `slice`, `splice`, `sort`,
  `reverse`, `fill`, `concat`, `Object.keys`, enumeration, the property
  enumerator of `for...in`. One predictable branch at builtin entry.

Reads and writes that stay sparse: `ts_array_get` / `ts_array_has_index`
(the table), `ts_array_set` (the table, with the length update and the
densify check), `pop` (the last entry), `length = n`, `delete arr[i]`,
`getOwnPropertyDescriptor`, JSON.stringify (reads through `ts_array_get`).
`push` on a sparse array stores at `len` into the table.

### Collector

A sparse store into an old array sets `gc_dirty_all` and remembers the
cell; the scan of a sparse cell visits every table entry (young and full
collections alike). `array_free_data` frees the table. `array_make_sparse`
and `array_densify` call `array_invalidate_dirty` so a remembered cell is
scanned completely after its storage changed shape.

### Loud reject

A store at index 2^32-1 (a named key in JavaScript, never an element) now
throws `RangeError: Invalid array index`; before it wrote out of bounds.

### Hot-path cost

The inline read compares against `cap` instead of `len`; `ts_array_set`'s
in-capacity path is a store, a length compare and the barrier; the grown
tail fill in `array_ensure_cap` is amortized one store per slot; `as_arr`
gains one predictable branch. `TSAOT_SPARSE_ELEMENTS=0` makes
`array_store_is_far` false (the invariant and the `cap` bound stay), which
isolates the sparse table in an A/B on one binary.

## Verification

- Fixture `arrays/sparse_far_stores`: far stores on empty, inline-backed and
  heap-backed arrays; reads before and after densification; `length`,
  `push`, `pop`, holes, `in`, `delete`, truncation and extension; every
  builtin on a sparse array; the fast-elements transition; frozen sparse
  arrays; reads beyond the length of dense arrays after `pop`, `shift`,
  `splice` and truncation (the invariant); young values in the tables of
  young and promoted arrays across collections. Identical to V8, also under
  `TSAOT_GC_YOUNG_THRESHOLD=1` and with the kill switch. The runtime
  statistics of the fixture: 29 conversions, 3,723 table stores, 4
  densifications.
- Kernel `benchmarks/patterns/sparse_stores.ts` (the flow-cache pattern:
  25,000 windows of 40 far stores and 40 reads).
- Compiler A/B, `x22` against `x20` (alternating three runs, outputs
  validated, diagnostics zero): 5.988 → 5.745 s median wall (−4.1%), peak
  RSS 1,139 → 811 MB, Node 3.23 s. Statistics relink: 2,412 conversions,
  9,684 table stores, 0 densifications per compile. Kernel: native 42 ms,
  Node 138 ms; under the kill switch the dense representation is killed
  after 21 s at 16.6 GB resident (the dropped caches' 32 MB buffers are
  malloc'd outside the collector's accounting; a pre-existing weakness
  recorded in the TODO).
