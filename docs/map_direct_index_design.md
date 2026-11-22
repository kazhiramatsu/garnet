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

## The hash of a number key (Session 367)

A Map or Set that is not direct hashes its number keys (`sv0_hash_num_d`, shared by the map code
and the in-line probes). The hash was MurmurHash3's fmix64 over the double's bits: two multiplies
and three shifts, fourteen instructions and about twelve cycles in front of the index load of
every hashed lookup by number. It is now the high word folded onto the low one (a small integer's
double has a zero low word) and one multiply, of which the high half is taken: seven instructions,
about six cycles.

The index's probe lengths under both, by a simulation of the runtime's own table (linear probing,
the slot word carrying the hash bits above the mask, one build at load 0.25 to 0.5 and the
incremental growth to load 0.75; 100,000 to 200,000 keys, as many absent keys of the same kind):

| keys | hit, fmix64 | hit, fold | absent, fmix64 | absent, fold |
|---|---|---|---|---|
| sequential ids | 1.31 | 1.33 | 1.81 | 1.69 |
| random ids in 1..3M | 1.31 | 1.30 | 1.80 | 1.77 |
| ids in 16384-id chunks (growth) | 1.67 | 1.51 | 3.21 | 2.55 |
| multiples of 16 / of 4096 | 1.31 | 1.20 | 1.80 | 1.60 |
| negative integers | 1.30 | 1.13 | 1.80 | 1.30 |
| fractions k/1024 | 1.31 | 1.28 | 1.80 | 1.71 |
| millisecond timestamps | 1.31 | 1.21 | 1.81 | 1.50 |
| random uint32 | 1.30 | 1.31 | 1.80 | 1.80 |
| n + 0.5 | 1.31 | 1.49 | 1.80 | 2.39 |

Equal or shorter everywhere but n + 0.5, and no key set with a long tail (the longest probe is
within the other hash's). tsc-ts, one thread: 13.651 to 13.618 G instructions (the hashed number
lookups are 1.3 M of its 8.4 M in-line Map and Set probes: 3.4 M direct hits, 0.9 M hashed hits,
0.4 M hashed misses, 1.4 M by string; `map_probe_inline` of the statistics build).

Measured and not kept with it: the density rule relaxed for a forked checker, whose id-keyed
tables stay hashed (it touches a fraction of the program's ids). 128, 512, 2048 and 8192 times
the live entries left the checker of checker.ts where it was (its check 251 to 260 ms against
260 on a loaded machine), 8192 cost the one-thread compile 3.6% of instructions for the tables'
fill: a sparse direct table is as cold as the hash index it replaces. A page-per-256-ids table
in tsc-ts for the same lookups (its `LinkTable` in place of the Map of `SparseLinkTable`) ran
1.4% more instructions in that checker.
