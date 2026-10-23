# Map entries: the key and its value in one line

Session 352, from the corrected profile of tsc-ts
(`docs/single_thread_vs_scriptc.md`, "The profile, corrected"): `ts_map_get`
5.6% of one compile's samples, `mapset_probe` 2.4%, `map_find` 1.1%,
`map_set_unchecked` 0.4%, `ts_str_hash_of` 0.5%. The checker's caches are
`Map`s: 9.4 M lookups a compile at 2.2 probes each, most of them hits on
maps of tens of thousands of entries.

## What a hit costs today

`ts_map` (runtime/ts_rt.h) keeps three dense arrays in insertion order,
`keys`, `vals` and `hashes`, plus the open-addressed `index` of slot words
(the dense index and the hash's high bits) and, lazily, `iteration_order`.
A hit on an indexed map reads, in dependence order:

1. the cell (`ts_is_map`: kind; `index`, `index_cap`, `keys`, `vals`),
2. `index[slot]` (one line of the index),
3. `keys[di]` (one line of the keys array: the key compare),
4. `vals[di]` (one line of the values array: the result).

On a map larger than the caches, 2-4 are three dependent misses; the probe
loop also rereads `keys` for each tag match. scriptc's maps (and V8's
ordered hash tables) read two: a bucket and an entry that holds the key
and the value together.

## The layout

```c
typedef struct { tsv key, val; } ts_map_entry;   /* 16 bytes, one line holds four */
typedef struct ts_map {
  ts_obj_common o;
  ts_map_entry* ents;  uint32_t len, cap;        /* insertion order; HOLE keys are deleted entries */
  uint32_t* hashes;                              /* parallel to ents: the scan filter, the index rebuild */
  uint32_t* index;  uint32_t index_cap;  uint32_t tombs;
  ...                                            /* weak, the dirty cards, iteration_order: unchanged */
} ts_map;
```

A hit reads the cell, `index[slot]`, `ents[di]` (key and value in one
line). `hashes` stays a separate array: the linear scan of a small map
(below `TS_MAPSET_LINEAR_MAX`) filters by hash before `same_value_zero`,
and an index rebuild reads every hash; neither is on the indexed hit path.
The slot word format, the probe, the tombstones, the compaction rule and
the insertion-order ids are unchanged; `ts_set_t` is unchanged (its one
dense array is already one load).

The number-key fast path (`map_find_num_fast`, inlined into `ts_map_get`
and `ts_map_has`) compares `ents[di].key == k` and the caller reads
`ents[i].val` from the same line.

## What changes, and what does not

- `runtime/ts_rt.c`, the Map section: `mapset_probe`/`mapset_scan` take
  `const ts_map_entry*` (the Set's callers pass their `elems` through a
  Set-specific variant or the probe takes a stride); `map_grow` reallocates
  one buffer; `map_compact`, `map_set_unchecked`, `map_delete_unchecked`,
  `ts_map_clear`, `ts_map_foreach`, `mapset_cursor_view` and the cursor
  functions, `ts_map_seed`, the iterator protocol, `ts_map_proto_init`'s
  methods.
- The collector: `gc_scan_cell` marks the `ents` payload (one
  `gc_payload_mark`), the dead-cell release frees one buffer, the dirty-card
  span is still indexed by entry (`map_write_barrier`'s card from the entry
  index); the g0 statistics count one buffer (`G0_P_MAP`); the weak-map
  ephemeron pass reads `ents[i].key/.val`.
- The generated code does not touch the arrays: for..of goes through
  `ts_map_cursor_*` (`docs/map_cursor_forof_design.md`), everything else
  through the runtime's functions. No emitter change, no parity change.
- Memory: the same bytes (two 8-byte arrays become one 16-byte array).

## Measurement

Kernels `map_string_keys` (3.0x scriptc's instructions), `map_forof`,
`class_nodes` (a `Map<number, number>` per node); tsc-ts one thread,
instructions and interleaved wall. Expected: the hit path loses one
dependent load and a few instructions; on tsc-ts a third of the 10% the
maps cost.

## Gates

Runtime unit tests (`scripts/run_runtime_tests.sh`: the hash-index tests,
compaction, iteration during mutation), conformance (`map`, `set`,
`weakmap`, `forof` fixtures) plain and strict, the GC stress gate and
protect mode (the entries are a payload the young and the full collections
mark), the bundler, the one-thread tsc-ts output compared byte for byte.

## Result (Session 352): not adopted

Built and gated on the collection fixtures (runtime unit tests, `map`,
`set`, `forof`, `weak`, `iter`, `json` plain and strict), then measured
against the strings-slice build on tsc-ts, one thread, six interleaved
pairs: instructions 1.0006, cycles 0.9998, wall 1.70 against 1.70 s. The
kernels did not move either (`map_string_keys` 1.79 G both ways;
`map_forof` 0.75 -> 0.70 G once the cursor read a Map's entry in place).
The maps' arrays are cache-resident on this workload: a hit's cost is the
dependent chain of L1 hits (the cell, the index word, the key, the value)
and the hash, about 30 cycles, and removing one 4-cycle link from it is
below the noise. The change was reverted; what would shorten the chain is
hoisting the receiver's checks and the index load out of loops, a cheaper
hash (integer tests for -0 and NaN instead of the float compares), and a
smaller index-to-entry path, each worth about a percent of the compile.

## The number key's hash (slice Q, session 352)

The class_nodes kernel (`benchmarks/patterns/class_nodes.ts`, 2.49x scriptc's
instructions) spent 40% of its time in `Map.get`: its 128 keys 0, 8, .., 1016
took 37 of the index's 512 slots, 5.8 probes a lookup. A small integer's
double has a zero low word, and `sv0_hash_num`'s single multiply left the low
bits of the hash, which choose the slot, poor. The full fmix64 finalizer (a
second multiply and shift) spreads them: 1.1 probes on that set and on 0..127,
and no set tried (ids 1..200000, multiples, negatives, halves, random) above
1.4 average. The kernel: 5.40 -> 4.72 G instructions, output unchanged. The
compile's `map_find` histogram does not move (2.22 probes average): those
lookups are string keys, whose FNV-1a hash distributes well in the low bits,
and small maps' linear scans; the number keys take the fast path, which the
histogram does not count. The statistics build now splits Map calls by key
kind, the number fast path's outcomes, and linear against indexed finds
(`map_keys:`).

## A lean lookup path (session 352, slice Z)

A symbol table's lookups, as a checker does them, cost 250 instructions each
in garnet against 80 in scriptc (`benchmarks/patterns/map_symbol_table.ts`:
a `Map<string, number>` of 20k identifiers probed with keys of equal content
built elsewhere). The probe loop itself is eight instructions an iteration
and the table averages two probes; the cost was around the loop:

- `mapset_probe` inlined `same_value_zero` for the candidate whose hash bits
  match but whose bits differ from the key's. That path forced a prologue
  saving fourteen registers and some fifteen instructions of tag constants
  before the loop, paid on every call, for a compare that runs once per hit at
  most. The compare is out of line now (`mapset_key_eq_slow`), and the probe
  loop keeps no spills.
- The compare itself went through `ts_strict_eq` to two `ts_strview`
  materializations and `ts_str_region_eq`. Two flat heap strings of one width
  and equal length now compare by `memcmp` (after the cached hashes, when both
  have one); a view, an immediate against a heap string, numbers and objects
  take SameValueZero as before.
- `map_find` was a call between `ts_map_get` and the probe; it is inline.
- The hash of an immediate (short) string was computed through the generic
  view loop, one `ts_str_cu_at_view` per unit. `ts_str_hash_fast` folds the
  immediate's bytes in line, the same value as `strhash_view` (a one-byte
  unit's two FNV-1a steps are one multiply by the prime's square), returns a
  hashed heap string's cached hash, and leaves the rest to `ts_str_hash_of`,
  which computes and caches.

Nothing about the table changes: the slot words, the dense arrays, the
maintenance rule and the hash values are as before, so the index of an existing
collection is still valid and iteration order is untouched.

| kernel | instructions | cycles |
|---|---|---|
| `map_symbol_table` (equal content, distinct objects) | -24% | -23% |
| `map_symbol_table`, keys rebuilt flat | -24% | -16% |
| `map_symbol_table`, the identical key objects | -22% | -22% |
| `map_object_keys` (a `Map<Node, T>` and a `Set<Node>`) | -21% | -21% |

Outputs identical in all four. tsc-ts one checker (the regular LTO build,
four pairs): 24.50 -> 24.14 G instructions (-1.5%), cycles -1.0%, wall 1.28 ->
1.27 s, outputs identical. (The same unit objects relinked without LTO against
the two runtimes agreed: -1.4%.)
The remaining gap to scriptc on string keys (about 2.4x) is the call into the
runtime and the generic tag dispatch at every site; a statically string-typed
key could take an inline probe as the unboxed number key does (slice T), a
possible later slice.

## Typed key probes in line (session 352, slice AC)

Slice T gave `map.get(k)` with an unboxed number key an inline probe; the 521
`ts_map_get` sites of the tsc-ts build with a boxed key still paid the call,
the receiver test and the tag dispatch, and the compile's generic lookups are
64% string keys and 32% object keys (`map_keys` statistics). The checker names
the key: the exporter puts the key kind on the key local (`Local.tyKind`:
"string" for string types, "reference" for object, array and function types,
null and undefined members set aside) where it lowers a `map.get`, `map.has` or
`set.has`; the IR's type table is not populated by the exporter, so the hint
rides on the local. A union with other members, `any`, `unknown` or a type
parameter names neither.

- `ts_map_get_str` / `ts_map_has_str` / `ts_set_has_str`: the indexed
  collection's probe in line with `ts_str_hash_fast` (now in the header), the
  identity test, and `ts_mapset_key_eq_slow` out of line for a candidate whose
  hash bits match but whose bits differ (equal content in another object: the
  checker's case).
- `ts_map_get_ref` / `ts_map_has_ref` / `ts_set_has_ref`: an identity probe
  with the address hash (`ts_ref_hash`, the value `sv0_hash` gives a heap
  reference); SameValueZero on references is identity, so no slow compare.

Every probe bails to the general entry when the receiver is not a Map or Set,
is weak, is still in linear mode, or when the key is not what the type said
(a number behind `string`, null or undefined behind an object type): the type
is a hint for the fast path, never trusted for the result. The probe loop is
`ts_mapset_probe_inline`, shared by the six entries. Knob:
`TSAOT_MAP_KEY_INLINE=0` keeps the calls (the parity oracle's output).
Fixture `maps_sets/map_typed_keys`.

With it, the receiver the type lied about: a `map.get` / `map.has` /
`map.set` / `set.has` / `set.add` on a value that is not that collection (an
object with its own `get` behind a `Map` type) threw "called on incompatible
receiver"; it now calls the object's own method, as the dynamic call would,
through `ts_collection_method_dynamic` (null and undefined throw V8's
property-read TypeError; anything else "is not a function").

| kernel | instructions | cycles |
|---|---|---|
| `map_symbol_table` (string keys) | -19% | -8% |
| `map_object_keys` (a `Map<Node, T>` and a `Set<Node>`) | -40% | -50% |

tsc-ts: see TODO (session 352, slice AC).
