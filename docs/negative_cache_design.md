# Absent-property entries (negative cache)

## Problem

A read of a property the receiver does not have (`if (!links.resolvedType)
links.resolvedType = ...`, the checker's lazy-caching idiom; `node.jsDoc`,
`symbol.exportSymbol`, optional members everywhere) misses the inline probe
(there is no slot) and then walks the whole out-of-line path: own-slot
probe, location table, class registry (a hash by prototype), own key scan
and the prototype chain (`lookup_prop_chain`), 50–80 ns each time. The
statistics relink of `native_s350x13` counted 3.58M such reads among its
5.66M out-of-line reads (63%; 249 reads resolved on the chain). V8 caches
the negative result in the IC behind a prototype-chain validity cell. The
`links_objects` kernel spends half its samples there after the plain-instance
change.

## Design

A bounded global table (8,192 entries, like the addition cache) remembers,
per (site, receiver shape), that a key is absent, together with a by-value
snapshot of the prototype chain: the shape of each prototype, at most three
deep, and the end of the chain. A hit requires

- the same site, receiver shape and key;
- an unchanged epoch (`g_prop_add_epoch`: bumped by a relinked prototype,
  a defined accessor, a registered class layout and a full collection);
- every link of the snapshot matched on the *current* chain: the object at
  that link is a plain object whose shape equals the snapshot (a shape fixes
  the own keys and attribute flags of a plain object — an added data
  property, an accessor, a deletion and a frozen attribute all change it; a
  dictionary-mode prototype has shape 0 and is never snapshotted), and
  `null` follows the last snapshotted link.

No identity is recorded: whichever object now sits at a link, equal shapes
mean the key is not there, so a moved, dead or recycled prototype cell
cannot mislead the check, and young prototypes (every short program's) are
cached like old ones. The receiver shape fixes the receiver's own keys, so
the own-slot probe and key scan are implied; a sized instance and a
dictionary receiver have shape 0 and are never recorded, nor are symbol
keys, chains through functions (their own properties are materialized
lazily) or proxies, or chains deeper than three. The entry is filled by
`ts_get_pic_checked` after a complete miss and consulted at its top, before
the megamorphic dispatch (a megamorphic site keeps its absent entries, one
per receiver shape that fits the table). The inline probe is unchanged:
the hit costs the out-of-line call, a hash and a few compares instead of
the walk; moving it inline is a follow-up if the call shows.

`TSAOT_NEGATIVE_PIC=0` (runtime environment) disables the entries.

## Verification

Fixture `objects/absent_property_cache`: absent reads repeated at one site
before and after the key is added to the receiver, to its prototype and to
`Object.prototype`, then deleted again; an accessor defined on the
prototype after the reads, redefined as data, deleted; the receiver
relinked with `Object.setPrototypeOf` and back; a prototype's prototype
relinked; a class hierarchy three deep with keys added at every level in
both orders; receivers of different prototypes, shapes and a dictionary
receiver at one site; a frozen prototype; 30k receivers with collections
between the reads and the writes; the runtime counters
(`pic_ool_get: absent / absent_cache_hits`), GC stress and the compiler A/B.
