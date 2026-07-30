# Dynamic object property lookup: shapes, PICs, and indexed fallback

## Motivation

Runtime profiling attributed about 44% of the flagship workload to dynamic
property access. The measured `find_prop` average was only 3.48 probes and 85%
of lookups used at most four probes, so a hash table alone does not remove the
dominant fixed dispatch cost. The implementation therefore uses three layers:

1. an ordinary-object fast path in `ts_get` and `ts_set`;
2. hidden shapes plus emitted four-entry polymorphic inline caches;
3. a sparse per-object index once an object has at least eight properties.

## Object layout and shapes

`ts_obj_common` stores:

- the dense, insertion-ordered `ts_prop` vector;
- an optional `key -> dense slot` open-addressing index;
- a packed 32-bit word whose low 29 bits are the hidden shape and whose high
  three bits are object-integrity flags.

Ordinary objects start at `TS_SHAPE_EMPTY`. Adding a new own key follows a
global `(parent shape, key) -> child shape` transition. Objects constructed with
the same property order therefore share a shape and dense slot layout.

Deletion compacts the property vector and changes the layout id to
`TS_SHAPE_NONE`. Such an object remains on the canonical dictionary path; it is
not reintroduced into the shape graph. Overwrites and descriptor changes keep
the shape because the key-to-slot mapping is unchanged.

Sized AOT class instances also start at `TS_SHAPE_NONE`. They share the ordinary
object runtime kind, but a registered struct field is resolved before the side
property vector. Consequently, their layout domain cannot safely alias a plain
object shape without adding a class/prototype guard to every cache entry. Typed
class access already uses direct struct offsets, so excluding the uncommon
dynamic class path preserves the compact cache and sends it through the
canonical/indexed fallback.

## Four-way PIC

Each emitted fixed or computed property site owns a zero-initialized
`ts_prop_ic`. An entry records:

- key;
- packed receiver shape/integrity word;
- dense property slot.

A fixed-key hit validates the receiver shape in an always-inline header helper,
then reads or writes a data property directly in the generated caller. Each
fixed site owns its cache and always uses one key, so a matched shape is enough
to identify the slot. Shape transitions structurally guarantee the cached
key/slot bounds; deletion changes the receiver to the uncacheable shape.
Accessor state has a dedicated property-flag bit, avoiding a heap-kind lookup on
each hit. Writable flags, integrity flags, write barriers, nullish errors, and
proxy traps retain their canonical behavior.

The cache only holds own slots on ordinary, non-sized objects, so their layout
is independent of the receiver's prototype. Omitting a prototype guard reduces
a four-way cache from 104 to 52 bytes per emitted site. The inline four-entry
loop is explicitly kept rolled to bound generated text growth.

Only own properties are cached. Typed struct fields, inherited properties,
missing properties, arrays, primitives, functions, promises, and proxies use
the existing runtime path. This avoids prototype-chain invalidation machinery.

After 16 misses, a site becomes megamorphic and calls the canonical lookup
directly from a small inline wrapper. This prevents a four-entry cache from
thrashing on sites that cycle through many shapes or computed keys and avoids
re-entering the PIC miss machinery after the transition. `TSAOT_PROP_PIC=0`
emits the previous non-PIC calls for A/B measurement and debugging.

## Indexed fallback

Objects with fewer than eight named properties retain the cache-friendly linear
scan. At eight properties, `find_prop` lazily builds an open-addressing index.
Index entries contain dense slot plus one, preserving zero as the empty marker.
Deletion rebuilds or removes the index after compacting the dense vector.

JSON object construction now uses the same `find_prop` creation path, so shapes,
indices, descriptor flags, and duplicate-key handling have one source of truth.

## Measurements

On the dedicated four-shape benchmark (20 million iterations, 40 million
property reads), a 40-pair interleaved A/B measured median wall times of 215 ms
for Git HEAD, 176.5 ms for the new ordinary-object path with PIC emission
disabled, and 93 ms for the final inline PIC. The combined result is about 57%
faster than Git HEAD and the PIC itself removes about 47% from the new canonical
path. The PIC reports 39,999,992 hits out of 40,000,000 reads.

The typed self-host emitter contains 9,278 PIC sites. Extrapolating from the
dedicated benchmark object gives roughly 1.8 MiB of additional text and
0.46 MiB of zero-fill cache storage for that workload. This is the accepted
code-size tradeoff for removing the dominant per-access runtime call; keeping
the probe loop rolled avoids the substantially larger fully unrolled form.

On the 32-key computed-property benchmark, the site correctly becomes
megamorphic (zero PIC hits). The adaptive index reduces `find_prop` average
probes from 16.50 to 1.38 and improves wall time despite repeated
`ToPropertyKey`/interning cost.

Correctness coverage is split by invariant:

- `object_methods/property_pic.ts` covers ordinary warm hits, shape mutation,
  accessors, descriptor redefinition, computed keys, and frozen writes.
- `object_methods/property_pic_edge_cases.ts` covers equal/different insertion
  sequences, get/set megamorphic transition, dense-slot compaction, own and
  inherited accessors, integrity changes, string/number/symbol/object keys,
  ToPropertyKey side effects, proxies, exotics, and nullish errors.
- `object_methods/property_dictionary_edge_cases.ts` covers the seven/eight
  threshold, index growth, first/middle/last deletion, shrink/re-growth,
  descriptor transitions, prototypes, symbols, integrity operations, and JSON
  duplicate keys.
- `classes/dynamic_class_registry_edges.ts` covers registry growth, the
  minimum-allocation-size guard, moving-GC revisits, and the constructor
  stack-buffer boundary at 15/16 arguments.
- `runtime/ts_rt_test.c` directly asserts shape sharing, the 16-miss state,
  dictionary shape after compaction, deterministic open-addressing collisions,
  class-registry growth, and the minimum-size guard.

Performance coverage lives in `benchmarks/property_pic_kernel.ts` and
`benchmarks/property_dictionary_kernel.ts`.

The final production-default benchmark battery completed 101/101 within budget. The
original completion run measured the PIC kernel at 91 ms and the 32-key dictionary
kernel at 95 ms; the expanded edge-test follow-up measured 94 ms and 96 ms respectively.
In the combined production configuration (PIC plus the independently measured root-frame
work), the full typed self-host emitter completed in 330.11 s versus the earlier 595 s
baseline; that end-to-end number is intentionally not attributed to PIC alone.
