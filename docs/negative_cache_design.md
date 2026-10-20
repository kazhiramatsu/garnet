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

## Epoch churn, and inline entries per site (Session 350, build `x63`)

### Finding

The `links_objects` kernel spent 30% of its samples in
`ts_get_pic_checked`, 39M out-of-line calls per run, every one answered by
the table above. Moving the answer in line was the planned follow-up, so
it was built first: one absent entry per inline-cache site (the receiver's
shape word, its direct prototype by identity, an epoch), tested by every
read helper after its probe misses; the chain beyond the direct prototype
was covered by watching the shapes of its links (an object leaving a
watched shape moved the epoch), young prototypes by moving the epoch at
the next minor collection. The kernel went from 468 to 403 ms. The
compiler went 2-3% slower.

Its statistics showed why: 200k epoch moves per compile, and 1.4M refills
of the site entries. 197k of the moves came from `ts_set_proto` called by
the runtime on objects it had just allocated: every Map / Set iterator and
every generator object (also array iterators, a typed array, the abort and
headers host objects) was created as a plain object and then relinked,
and a relink moves the epoch of the addition caches (`g_prop_add_epoch`),
which the absent table and the per-site addition entries share. So every
iterator emptied every addition and absent cache of the program, since
`x26`.

### Change

The runtime links a fresh object's prototype without moving any epoch
(`obj_link_fresh_proto`): the object is nobody's prototype yet, and the
caches key their receivers by shape and prototype, so no cached decision
can involve it. The user-level relinks and the class setup keep
`ts_set_proto`. Per compile: epoch moves 200k -> 3.2k; slow additions
1.45M -> 0.30M (site entry hits 7.4M -> 8.5M); absent walks 856k -> 9k
(the table keeps its entries); out-of-line reads 4.72M -> 2.01M.

The per-site inline entries were then neutral on the compiler (3.521 vs
3.527 s with the fix alone, seven interleaved runs each) and cost 6.6 MB
of code (`__TEXT` 39.5 -> 46.1 MB: the test sits after every read site's
probe), so they are not adopted. The kernel keeps its out-of-line answer.
If they come back, they belong only at the reads of optional properties
(the declared type says the key may be absent), where the code stays
small; the invalidation scheme above (watched shapes, the young-prototype
rule) is in the Session 350 `x63` notes of `docs/TODO.md`.

### Verification

Fixture `objects/absent_site_entries` (also in the GC stress gate): each
case reads at one site in a loop and changes the chain between iterations,
because the analyzer inlines small readers and every call site has its own
cache — a prototype gaining, losing (dictionary) and regaining the key, a
frozen prototype; an object sharing the prototype's shape; the receiver
and a prototype's prototype relinked; an accessor, a read-only data
property and a deletion on the prototype; prototypes dying young at a rate
of one per read; two receiver shapes alternating; a four-deep chain and
arrays; prototypes promoted between reads; `Object.prototype` gaining and
losing a key. Built against the per-site variant with one invalidation
removed, it fails without the watched-shape move and without the shared
epoch. Fixture `objects/fresh_proto_links`: the prototypes, tags and
iteration of the objects now linked fresh, and additions to plain objects
interleaved with them.
