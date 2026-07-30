# WeakMap / WeakSet design

`WeakMap` and `WeakSet` share the existing `ts_map` / `ts_set_t` storage and
open-addressing hash index. A brand bit keeps ordinary and weak collection
prototypes and APIs distinct. The index contains only dense-array positions, so
it never becomes an additional GC edge.

## GC semantics

WeakSet entries are never marked by the container. WeakMap entries are
ephemerons:

1. Ordinary roots and strong object edges are marked first.
2. For every reachable WeakMap, a value is marked only when its key is already
   live.
3. Marking such a value can expose another weak key, so all reachable WeakMaps
   are revisited until no new value is marked.
4. Dead-key entries are removed before sweeping and before their stable handle
   slots can be recycled.

For a minor collection, old-generation keys are live by definition because
they are outside the collection boundary. Young keys must be marked normally.
The existing write barrier enrolls an old weak container in the remembered set
when a young key or value is inserted; scanning that remembered entry applies
the same ephemeron rule rather than strongly tracing both fields.

This preserves the important cycle rule: a WeakMap value that points back to
its own key does not keep either object alive.

### Symbol keys

`CanBeHeldWeakly` also accepts Symbols that are not registered in the global
symbol registry. The runtime therefore treats:

- `Symbol()` and `Symbol(description)` as collectible weak keys;
- well-known Symbols such as `Symbol.iterator` as valid keys (their permanent
  roots mean their entries are effectively long-lived);
- `Symbol.for(key)` results as invalid weak keys because the registry holds
  those identities strongly.

User-Symbol property keys remain strong edges. Although `ts_prop` stores only a
compact `sym_id`, property scanning resolves the Symbol through a weak
`sym_id -> Symbol` identity table and marks it. Creating a Symbol-named property
also applies the normal old-to-young write barrier. The identity table itself
is not a root and dead entries are cleared after the ephemeron fixed point,
before handle reuse.

## Map/Set lookup structure

Map and Set do not use a comparison tree. JavaScript keys have SameValueZero
semantics and object-identity keys have no useful total order, so a balanced
tree would add `O(log n)` comparisons and complicate mixed key types.

The runtime instead preserves insertion order in dense arrays and uses an
open-addressing side index for non-trivial collections. Each dense entry now
caches its normalized SameValueZero hash. Lookups therefore compute the query
hash once, skip equality checks for different hashes, and remain expected
`O(1)`. Very small collections intentionally use a short linear scan because it
is cache-local and avoids allocating a separate index.

The `gc_mapset_churn` regression fixture performs 800,000 updates over
4,096/2,048-key collections. On the 2026-07-30 development run, its
`map_find` average probe count was 1.30 (the pre-index historical baseline in
`refactor_baseline.md` was 2,219.58). The wall time was 10 ms versus the
historical 760 ms; wall-clock figures are machine-dependent, while the probe
count is the primary structural regression signal.

## Supported surface

- `new WeakMap(iterable?)`, `set`, `get`, `has`, `delete`
- `new WeakSet(iterable?)`, `add`, `has`, `delete`
- typed calls, dynamic/`any` prototype dispatch, and first-class prototype
  methods
- object, function, ordinary Symbol, and well-known Symbol keys
- `Symbol.for` and non-Symbol primitive insertion throw `TypeError`; invalid-key
  queries report absence

Weak collections have no iteration, `size`, or `clear`.

## Regression coverage

`runtime/ts_rt_test.c` exercises the collector-specific invariants that cannot
be observed deterministically from JavaScript:

- live/dead keys, replacement and deletion, unreachable containers, and
  value-to-key cycles;
- multi-map ephemeron fixed points and mixed live/dead pruning after the hash
  index has been built;
- minor-GC splits for old container/young key, old key/young value, and
  WeakSet remembered-set entries;
- object and function identities, ordinary/well-known/registered Symbols,
  Symbol value-to-key cycles, and strong Symbol property-name edges;
- old-owner-to-young-Symbol barriers and fixed points reached through a Symbol
  property name.

`tests/conformance/exhaustive/maps_sets/weak_collections.ts` is compared with
the Node/V8 oracle and covers constructors (array, generator, null/undefined,
duplicates, malformed inputs), all public methods, chaining and identity,
primitive error/query behavior, every prototype brand check, dynamic and
first-class dispatch, Symbol key classes, and the deliberately absent
iteration/size/clear surface.
