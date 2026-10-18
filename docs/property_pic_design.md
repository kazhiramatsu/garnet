# Dynamic object property lookup: location caches and indexed fallback

## Motivation

Runtime profiling attributed about 44% of the flagship workload to dynamic
property access. The measured `find_prop` average was only 3.48 probes and 85%
of lookups used at most four probes, so a hash table alone does not remove the
dominant fixed dispatch cost. The implementation therefore uses three layers:

1. an ordinary-object fast path in `ts_get` and `ts_set`;
2. emitted four-entry caches of verified storage locations;
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
`TS_SHAPE_NONE`. Sized AOT class instances also start at `TS_SHAPE_NONE` because
registered struct fields take precedence over the named-property vector.
Both cases remain eligible for the out-of-line location cache below. Ordinary
objects with a nonzero shape also retain a short inline shape-cache path.

## Compact shape cache and separate location hints

Each emitted fixed or computed property site owns a zero-initialized
`ts_prop_ic`. It retains the original 52-byte layout: four `(key, shape, slot)`
entries and replacement/failure state. Ordinary fixed-key hits use the original
short inline probe, with no registry-epoch load, prototype comparison, allocation
size comparison or auxiliary-table lookup. Only ordinary unsized objects have
nonzero shapes; sized class instances and deleted layouts cannot alias them.

Unsized receivers, including objects after deletion, first try a compact
cached slot with a live bounds/key check. No auxiliary table, prototype or
registry-epoch check is needed for their own properties. This also handles
shape variation without enlarging the ordinary cache.

Sized receivers use a separate bounded table with four verified locations per
site address. Its 4,096 direct-mapped buckets occupy 576 KiB of zero-fill storage.
Collisions only discard hints. Entries record the live prototype, allocation size, key, storage kind and
offset; the bucket also checks the site address and class-registry epoch.

An own-slot hit validates its bounds and current key. This permits unrelated
property additions, differing insertion orders with the same target slot, and
deletions without accepting stale slots. Warmup populates distinct entries
for up to four shapes, even if their target slots coincide. After warmup, unseen
shapes are promoted at a sampled rate; dictionary hits do not evict an ordinary
shape just to record shape zero. Struct offsets bypass both
the class registry and its field search. Registry growth invalidates these
auxiliary entries, preserving struct-field precedence after late registration.
Allocation-size equality separates a real class instance from a short
`Object.create(Class.prototype)` receiver.

Accessor state and write permissions remain live checks; getter/setter changes,
frozen objects, proxies, nullish errors and write barriers retain canonical
behavior. The inline probe stays rolled to limit generated text growth. Caches
store handles and offsets, never raw movable pointers. Prototype handles are
only compared with live receiver handles, never dereferenced or added as GC
roots.

Fixed-key shape variation and missing properties no longer retire a site.
Repeated computed-key diversity can still retire it after sixteen evictions.
Interface method dispatch emits a field-key cache and a method-key fallback
cache. Caching a location, rather than a function value, observes reassignment
and invokes an accessor on every call. Inherited/missing properties, arrays,
primitives, functions, promises and proxies retain canonical lookup.

The canonical class-field path has a 1,024-entry direct-mapped cache of
`(prototype, key, registry epoch) -> (offset, numeric flag, minimum size)`.
Negative registry results are cached too; positive results keep the minimum-size
guard. Registry growth invalidates hints without storing registry-vector
pointers. `TSAOT_PROP_PIC=0` disables emitted property/method caches for comparison.

Two rejected implementations enlarged every emitted cache from 52 to 136 bytes;
one also inlined all prototype/size/key/epoch checks. Both regressed the native
compiler despite reducing property searches. The final design preserves the
existing ordinary-object layout and guard sequence. Hit rates alone do not
establish profitability; whole-project comparisons remain the deciding measure.

## Indexed fallback

Objects with fewer than eight named properties retain the cache-friendly linear
scan. At eight properties, `find_prop` lazily builds an open-addressing index.
Index entries contain dense slot plus one, preserving zero as the empty marker.
Deletion rebuilds or removes the index after compacting the dense vector.

JSON object construction now uses the same `find_prop` creation path, so shapes,
indices, descriptor flags, and duplicate-key handling have one source of truth.

## Earlier shape-cache measurements

The figures in this section predate the location-cache changes above.

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
- `runtime/ts_rt_test.c` directly asserts shape sharing, fixed-key cache retention,
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

## TypeScript compiler workload

The native TypeScript 6.0.3 workload checks and emits all 78 files in the
upstream compiler project and compares diagnostics, exit status and every
emitted byte with the Node build. See `benchmarks/typescript_native/README.md`
and `docs/bench_results.md` for commands, flags and measurements.
`benchmarks/interface_property_kernel.ts` separately exercises interface reads,
writes and method calls across 32 layouts, including dictionary objects.

## Property-addition cache

Stores that add a property can never hit the per-site shape cache: the
receiver's hidden class changes with every addition, so a constructor or a
literal that initializes a fresh object field by field misses on each store.
On the native TypeScript workload the store cache hit only 2.5% of 73M
fixed-key stores, and each miss re-ran the struct-field registry probe, the
own-slot scan, the prototype-chain accessor walk and the transition-table
lookup before appending.

`ts_set_pic` now consults a bounded global table (4,096 entries, 160 KiB)
keyed by the site and the receiver's pre-addition shape. An entry records the
key, the direct prototype, the slot (the length before the addition), the
resulting shape and an epoch. A hit appends through the same `props_append`
helper that `find_prop` uses and reuses the recorded shape, so the slow
path's hidden-class, index and flag behavior is reproduced exactly. The entry
is only filled after a slow-path addition that actually appended one own data
property to a plain, extensible, non-dictionary receiver with a string key.

The hit conditions reproduce the slow path's decision: the same shape fixes
the own key sequence and the integrity bits, the same direct prototype plus an
unchanged class-layout state fixes the struct-field answer, and the epoch
guards everything that could introduce an inherited setter or recycle a
prototype handle. The epoch moves on every accessor definition, every
`setPrototypeOf`, every class registration and every collection (minor or
full), because freed handles may be reused by new prototypes. Symbol keys and
sized class instances never enter the cache. `objects/add_transition_cache.ts`
covers later-installed inherited setters, prototype relinks, frozen and
non-extensible receivers, dictionary receivers after deletion, index growth,
polymorphic sites and sized receivers.
