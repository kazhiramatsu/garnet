# Per-site addition entries of the property store cache

Implemented in Session 350 (slice `x26`); runtime only (`runtime/ts_rt.h`,
`runtime/ts_rt.c`). Also fixes a pre-existing silent miscompile of the slow
store found by the slice's fixture (below).

## Finding

The runtime statistics of `x24` counted 10.1M out-of-line property stores
per compile, of which 6.93M were additions answered by the global addition
cache (`docs/...` in `ts_rt.c`: a 4,096-entry table keyed by site and
receiver shape, Session 350). Each such store still paid, in
`ts_set_pic`, the own-slot probe, the location-table probe and the hashed
global-cache probe before `props_append`: three misses and a hash per
constructor field. The checker's `Type`, `Symbol`, `Node` and `Links`
objects are initialized field by field by constructor functions, so this
is the dominant store shape of the compile.

## Change

`ts_prop_ic` carries the addition the site last performed: the receiver's
shape word before and after, the slot (its length before), the key, the
epoch of the addition cache and the direct prototype (24 bytes per site;
45,578 sites in the compiler). `ts_set_pic` tests it first: the same
conditions as the global cache (same shape word, which fixes the own keys,
attributes and integrity bits; same length; same key; same prototype by
identity; unchanged epoch; an unsized receiver), then `props_append` and a
slot-precise write barrier. A miss falls through to the existing probes
and the global cache, whose hit also refreshes the site entry; the slow
addition fills both.

The slot-precise barrier (`ts_write_barrier_ptr`) now also covers the
out-of-line overwrites of shaped receivers in `ts_set_pic`, so an old
receiver remembers a dirty card instead of a whole-cell scan (the
remembered-set precision item of the TODO; dictionary receivers keep the
whole-cell barrier because their entries are not value slots).

## The miscompile the fixture found

`ts_set_named_prop` (the slow store) walked the prototype chain only for
inherited accessors. An inherited read-only data property (defined with
`writable: false`, or any property of a frozen prototype) did not reject
the write: the receiver silently gained an own property where V8 throws
`TypeError` in strict mode. The walk now rejects the write when the
inherited data property is read-only or its holder is frozen, and lets a
writable one create the own property (OrdinarySet). The addition caches
validate the prototype by identity, not by its attributes, so
`Object.freeze` and a `writable: false` definition now bump the addition
epoch, like accessor definitions and prototype relinks already did.

## Verification

Fixture `objects/add_transition_site_cache`: constructor functions
initializing fresh objects, one site over two shapes, frozen and sealed
receivers, an accessor and a read-only data property defined on the
prototype after the entry was recorded, a relinked prototype, dictionary
receivers, class instances with struct fields, symbol keys, existing keys,
growth past the in-object slots, and additions to 5,000 old receivers
across collections. Identical to V8, also under
`TSAOT_GC_YOUNG_THRESHOLD=1`. The `x25` runtime fails the read-only
prototype case the same way (the defect predates the slice).

## Results

Statistics relink (`x26`): additions 6.93M site-entry hits, 12k global
hits, 1.22M slow fills per compile; remembered-set slot writes 735k →
825k, whole-cell marks 1.77M → 1.68M; GC pause 544 → 484 ms. Compiler
A/B against `x25` (alternating three runs, outputs validated, diagnostics
zero): 5.548 → 5.494 s median wall (−1.0%, all three pairs agree), Node
3.23 s.
