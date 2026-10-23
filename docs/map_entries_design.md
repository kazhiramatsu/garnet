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
