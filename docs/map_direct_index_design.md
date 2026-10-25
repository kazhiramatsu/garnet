# A Map keyed by small integers indexes by the key

Session 353. The checker's hottest lines are lookups in `Map<number, T>`
tables keyed by node and symbol ids: `c.resolvedSymbols.get(node.id)` is 1.8%
of a checker's samples on the compiler project, the one-entry cache in front
of `nodeLinkTable.get(id)` 1.2%, and `map_find`, `map_set_unchecked` and the
index rebuilds another 2%. Each lookup hashed the double, probed the
open-addressing index, compared the key and loaded the value: four dependent
loads on cache-cold arrays.

## The direct table

A Map whose keys are all non-negative integers below 2^26 (`TS_MAP_DIRECT_MAX`)
and dense enough (the largest key plus one at most 32 times the live entries
plus 64, `TS_MAP_DIRECT_SPARSITY`) gets a **direct table** instead of the hash
index: `direct[key]` holds the
dense index plus one, 0 for absent (`ts_map.direct`, `direct_cap` a power of
two). A lookup is then the key's own value checked against the bound, one load
of the table and one of the value: no hash, no key compare, and the key is
known to be absent when it is not a small integer (every stored key is one).
The dense `keys`/`vals`/`hashes` arrays and the insertion order are untouched;
iteration, `forEach`, the cursors and the published-collection paths do not
know the difference.

- **Entering.** Decided where the index would be built or rebuilt
  (`map_index_maintain`: at eight live entries, and at each hash-index
  growth), by a scan of the keys (`map_direct_eligible`): all small integers
  and dense. A map that grows into density later converts at its next
  rebuild.
- **Growing.** A key beyond the table but within the density rule grows the
  table to the next power of two (`map_set_unchecked`); the hash arrays keep
  the key's hash so the hash index can be rebuilt at any time.
- **Leaving.** A key the table cannot hold (a string, a negative number, a
  fraction, NaN, an id past the rule) rebuilds the hash index over the same
  entries and frees the table (`map_direct_to_hash`); nothing observable
  changes.
- **Deleting and compacting.** A delete clears the key's slot and leaves the
  usual hole; the compaction past the tombstone threshold rebuilds the table
  (or gives it up if the survivors are no longer dense). `clear` zeroes it.
- **The collector.** The table is a payload of the map like the hash index:
  marked with the cell, released with it, counted in its heap bytes, marked
  old by a shared worker's publish.
- **The inlined probe.** Generated `Map.get`/`Map.has` with a number key run
  `ts_map_probe_num` in line (`ts_rt.h`); it takes the direct path first and
  falls back to the call only for a hashed map's collision cases, as before.

Sets keep the hash index.

## Measured

- Runtime tests: the direct table through 5,000 even keys, -0 finding +0,
  fractions, NaN and negatives absent, deletes past the compaction threshold,
  a string key moving the map to the hash index with every entry, sparse keys
  never direct, a far key within the density rule growing the table and one
  past it giving it up, clear and reuse.
- Fixture `stdlib/map_int_keys_dense` (V8): the same through the JavaScript
  surface, with insertion order after conversions and a 2^21 id range at 20%
  occupancy.
- Kernel `benchmarks/patterns/map_int_keys` (id-keyed tables with a one-entry
  cache, as the checker's accessors): 0.91 to 0.80 G instructions, 0.20 to
  0.10 G cycles.
- tsc-ts, one checker, against the hashed build (trained builds, interleaved):
  instructions 0.9896, cycles 0.9456, wall 0.942; outputs identical at 1, 2, 4
  and 8 checkers; the protected run clean (the table is a published payload
  the readers only read).
- The density rule, by the same one-checker compile: a factor of 4 left the
  checker's maps of node ids hashed (they hold about a tenth of the id range:
  cycles 0.9936); 16 took them (0.9579, peak memory unchanged at 614 MB); 32
  another 0.65% of cycles for 19 MB; 64 another 0.5% for 13 MB more. 32 is the
  setting: at worst 128 bytes of table per entry, which the map's own arrays
  and values dwarf.
