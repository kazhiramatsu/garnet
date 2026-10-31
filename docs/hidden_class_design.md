# Hidden classes for the dynamic paths (design, Session 356)

Kaz's direction (2026-10-28): real projects spend their time in the dynamic paths, and those
should run at V8's level; "it may be time to put the dynamic accesses through hidden classes
too". This document records where garnet stands, what V8 does that garnet does not, and the
slices that close the gap, in the order they are taken.

## Where garnet stands

Two layout systems describe an object's keys:

- **Shapes** (plain objects and arrays): a shape id in the header's `shape` word (29 bits, the
  top 3 the integrity flags), a transition tree (`shape_transition_f`: (parent, key, flags) ->
  child, one edge table), per-shape key and flag vectors (`g_ts_shape_keys`, `g_ts_shape_flags`)
  and the probe tables the inline cache reads (`g_ts_probe_rkeys` / `wkeys`: shape x slot ->
  key). A shaped object's values are in-object slots, then the `props` vector. A dictionary
  object (shape 0) keeps `ts_prop` entries and is never cached in line.
- **Class words** (sized instances of the program's classes): a class index in `cls`, the
  struct layout from the class registry (`class_field_lookup`, by (class word, key) through
  `g_class_word_cache`), `shape` 0, own dynamic properties in a sidecar (`dyn`). The caches for
  inherited reads (`g_method_cache`: (class word, key) -> holder, holder shape, slot), absent
  reads (`g_sized_absent`: (class word, key) -> chain snapshot) and the per-site sized entries
  (`docs/pic_sized_inline_design.md`) are all keyed by the class word.

A site's cache (`ts_prop_ic`, 80 bytes) holds four entries (key, shape word or tagged class
word, slot with the attribute flags above it), the miss count that makes it megamorphic at 16,
and one absent record (`docs/absent_reads_inline_design.md`). The inline probe
(`ts_prop_ic_probe_fixed_inline`) is entry 0's shape, then entry 0's slot validated against the
receiver shape's key vector, then entries 1-3; a site typed as admitting a class instance also
probes the sized entries (`ts_get_sized_pic_try`). Behind the site: the global absent table
(`g_prop_absent_cache`, (site, shape, key) -> chain snapshot of up to three prototype shapes),
the location table for sized and dictionary receivers (`g_prop_locations`, per site), and the
generic read (`ts_get`: `lookup_prop_chain`, a `prop_find` per link: a linear scan under 8 keys,
the shape's index above).

What this costs on vue (Session 356's annotated profile, before the first dynamic-path slice):
the out-of-line read 8.7% (`ts_get_pic_checked` 4.0%, its slow path 4.6%: absent reads on
megamorphic sites and every read whose receiver is a Proxy), `prop_find` 3.0% (`Reflect.get`'s
chain walk), `map_find` 3.6%, the trap lookup 3%, the trap call 4.2%, `Dep.track` 6.2% (twenty
interface-typed probes). The first slice (the trap cache, the leaf's proxy and megamorphic-absent
answers, direct trap calls: vue -6.7%) is in `docs/real_projects.md` "The third round".

## What V8 does (the reference)

- One **map** per object: the keys and their attributes, the in-object slot count, the
  prototype, the elements kind, the transition tree. A class instance and an object literal are
  the same kind of object with different maps.
- **Inline caches** per site: monomorphic, polymorphic (up to four maps), then **megamorphic**,
  which consults the global **stub cache**, a hash table keyed by (map, name) holding the
  handler (an own slot's offset, a prototype holder's slot, "absent").
- **Prototype validity cells**: a prototype object gets a map of its own, and a cell that every
  change to the prototype (own keys, attributes, its prototype) and to anything above it
  invalidates (the prototype's users are registered with it). A handler for an inherited or
  absent property checks the receiver's map and the prototype's cell: O(1), no chain walk.
- **Keyed accesses** (`o[k]`) have the same caches with the name in the feedback, and the stub
  cache behind them.

## The slices

Each slice is runtime-only unless noted, gated by one knob, measured by the real-project A/Bs
(vue, rxjs, yaml; alternating binaries, seven runs) and the tsc-ts instruction A/B, and kept
behind the full gate set (conformance in three modes, unit, bundler, bench, GC stress). The
fixtures mutate the structures between the cached accesses: a key added to or deleted from a
receiver, a prototype, an intermediate prototype, `Object.prototype`; an accessor defined; a
relink; a frozen object; a dictionary-mode object; a Proxy in the chain.

### S0. `this` and the receivers of an unstable class (built, Session 356)

`Dep.track` read `this.computed`, `this.activeLink` and `this.version` through the sized inline
cache although `Dep` is a declared class: vue's `Dep`, `ReactiveEffect` and `ComputedRefImpl` are
*unstable* in the structural flow pass (`class_extract.ts`: a `Map<any, Dep>` whose `new Map()` is
`Map<any, any>` flows an `any` into a `Dep`-typed binding; `(e as ReactiveEffect)` casts a
`Subscriber`), and an unstable class took no class hint and no struct-direct access anywhere.
The instability is a static fact (a value of another kind may be typed as the class); it says
nothing about the instances, which are sized structs with the declared layout. Two rules:

- **A method's `this`** of a class with a class interval (its subtree's instances all sized, the
  chain preserved: the emitter's `ranged` set) reads its declared fields at their struct offsets
  with the same guard a stable class's `this` has (the typed-slow flag's interval test): a foreign
  `this` arrives only through a borrow, a relink or an `Object.create` of the prototype, each of
  which raises the flag. `this_local` in the emitter's context, `struct_offset_for`;
  `TSAOT_THIS_DIRECT=0` keeps the cache.
- **Any other receiver typed as such a class** (a parameter, a hinted expression) reads the struct
  slot under the always-on interval guard `!ts_is_obj(o) || cls - lo >= span`, one compare and one
  load, which is what a monomorphic map check costs; a value of another kind takes the generic read.
  The exporter hints an unstable class whose reasons are all static (`classLayoutPreserved`: no
  foreign base, no reassigned prototype), marking the site `sized` as well so an emitter that has
  no interval for the class keeps the sized probe; `hint_guard` admits only the interval guard for
  an unstable class (the root and leaf guards rest on the structural proof the class lacks), and
  the `known` path (parameters, allocations) takes the same guard. `TSAOT_UNSTABLE_HINTS=0` keeps
  the sized cache. The integer-slot facts of a hinted load stay with stable classes.

Fixtures `classes/unstable_this_direct` (a borrowed method on an instance of another class and on
a plain object, an `Object.create(C.prototype)` receiver, a plain object typed as the class whose
own methods run, a relinked instance, a subclass) and `classes/unstable_hint_range` (instances, a
subclass, another class, plain objects with and without the fields, a relinked instance, a frozen
instance's write, null and undefined, an instance with an own dynamic property). The first one
also showed the documented typed-mode trust (CLAUDE.md known items): a plain object's own method
that returns a string where the class's method is typed `number` reads NaN, so the fixture's fake
is type-honest.

### S1. The global stub cache (tried and withdrawn, Session 356)

Built as planned (`g_stub_cache`, 4096 entries of (map word, key) -> OWN slot / STRUCT field /
PROTO holder slot / ABSENT chain snapshot, probed by the leaf read of a megamorphic or
absent-recording site, the generic read, `Reflect.get` and `in`, filled by the slow paths) and
measured on vue with `--rt-stats`: 26 M hits, 0.8 M misses, 11 k fills, and the run **+1.3%
instructions with the cache on against off, +1.9% off against the runtime before it**. The
cache is redundant with what garnet already has: a shaped object's own slot is found by the
shape's key index (above 8 keys) or a scan of a key vector that fits a cache line (below), an
absent read by the absent table (one hash and the same chain compare), a sized instance's field
and inherited reads by the registry and method caches; the stub probe replaced each of those
with a probe of the same cost and added its own misses and fills, and the code it put into the
leaf read and the generic read cost every call. V8 needs a stub cache because its megamorphic
fallback is a descriptor search; garnet's shapes carry an index. Withdrawn.

What the measurement did show, and what stayed (`docs/TODO.md`): the site that reads
`v.__v_isRef` never became megamorphic, because an absent read fills the site's absent record
and not its entries (whose miss count makes a site megamorphic), so every receiver of another
shape went inline miss -> leaf -> slow path -> absent table: 16.7 M times per vue run. The leaf
now answers a receiver of another shape at a site with an absent record (its record's tag) from
the absent table directly (objects and arrays; a primitive through its wrapper prototype's entry,
out of line), which moved 13 M of those reads out of the slow path: vue -1.4% instructions. The
general lesson for the slices below: on garnet, a cache pays only where it removes a *path*, not
where it replaces a lookup of the same cost.

The plan (for the record):

A table keyed by (map word, key) where the map word is the receiver's shape word (a shaped
object or array) or its tagged class word (a sized instance), holding the location:

```
struct { uint32_t map; ts_key key; uint32_t epoch; uint8_t kind; uint8_t numeric; uint32_t at; tsv holder; uint32_t holder_shape; }
kind: OWN (a shaped object's slot `at`), STRUCT (a sized instance's field at byte offset `at`,
      `numeric` its kind), INHERITED (the direct prototype `holder`'s slot `at`, valid while the
      holder's shape is `holder_shape`), ABSENT (the chain snapshot as the absent table keeps it
      until S2 replaces the snapshot by the prototype's cell)
```

8192 entries (direct-mapped, 32 bytes each), hashed by `(map * K1) ^ (key * K2)`. Filled where
the slow read resolves the property (`ts_get_pic_checked_slow`, `ts_get`'s chain walk); probed
first at a megamorphic site (`ts_get_pic_checked` when `ic->megamorphic`), by the generic read
for a shaped receiver before `lookup_prop_chain`, by the dynamic-key read, by `Reflect.get`'s
data-property path and by `in` (`ts_has_prop`). The epoch is the addition cache's
(`g_prop_add_epoch`, moved by relinks, accessor definitions, class registrations and full
collections), so a hit needs the map word, the key and the epoch, and for INHERITED the
receiver's prototype identity and the holder's shape. The existing absent table stays for the
site records; its entries move into this table keyed without the site (two sites reading the same
key on the same shape share one entry). Knob `TSAOT_STUB_CACHE=0`. Expected: vue's `Reflect.get`
and `arrayInstrumentations[key]` reads and the `in` of `isNonTrackableKeys` (about 3%), tsc-ts's
megamorphic present reads (`ic->megamorphic` -> `ts_get` -> `prop_find` with the shape index
today).

### S1b. The path trims (built, Session 356)

What the S1 measurement pointed at, taken one by one with the annotated profile:

- **The leaf read keeps no frame.** `ts_get_pic_checked` had a prologue and an epilogue (callee-saved
  registers, a 0x50-byte frame) because of the plain calls inside it (`prop_find` on a sized
  receiver with dynamic properties, `class_field_lookup`), and every inline miss paid them: 13% of
  vue's samples were prologues, the leaf's first among them. Its out-of-line parts are now tail
  calls: `ts_get_pic_sized` (a sized instance's inherited and absent caches, the megamorphic
  registry probe, the sized entries), `ts_get_pic_other` (an array's absent read, other kinds),
  `ts_get_proxy_keyed`, `ts_get_pic_primitive`, `ts_get_pic_checked_slow`; what stays in line is
  call-free: the site record, a plain object's absent-table probe, and a class instance's
  inherited and absent cache hits when it has no own dynamic properties (the dynamic-property
  test calls `prop_find`), the megamorphic registry entry and the site's sized entries read by
  kind (`sized_field_read`). The first cut sent every sized receiver out of line and cost rxjs
  1.1% (`destination.next`, an inherited read on every subscriber); with the hits in line rxjs
  gains 0.3%. vue -2.5% instructions.
- **ToPropertyKey in line for a canonical key string** (`ts_key_from_value`: the string a key id
  reconstructs to carries `TS_STR_FLAG_KEY`, and that is what a Proxy trap receives and hands to
  `Reflect.get`, `in` and the invariant check); everything else in `ts_key_from_value_slow`.
- **The Proxy operations root in one shadow frame** (`ts_proxy_frame`, `ts_frame_push` as a
  generated function roots its locals): a proxied read paid seven root pushes and a pop. The
  slots are read back after every call (a young cell may move); a throw through a trap restores
  the frame top at the handler as it restores the roots. vue -1.2% instructions. Fixture
  `proxy/trap_gc_frames` (traps that allocate through many collections with every value alive
  across the trap, a proxied read inside a trap, a throw through the frame, a trap replaced from
  inside a trap).

### S1c. The trap name's index per call site (built), the sized-first probe (tried, Session 356)

- **The trap name's index per call site**: `ts_proxy_trap(pv, handler, "get")` resolved its name
  by a scan of the registered names on every lookup; the macro now keeps the index in a static
  per site (the names are literals) and the lookup is the cache probe alone. vue 31.384 ->
  31.347 G instructions, 1,102.6 -> 1,095.5 ms alternating; rxjs unchanged.
- **The sized probe first at an interface-typed site** whose first cache entry is a sized
  receiver's was tried and reverted: vue -0.25% instructions, rxjs +0.3% (its interface-typed
  reads are inherited methods, which the sized entries never hold, so the sized try always
  missed before the plain probe's fast failure), a wash that put a test into the inline helpers
  of thousands of sites. The polymorphic interface site stays S4's business (one map word, one
  probe).

### S1d. Inherited reads of plain objects (built, Session 361)

S1's lesson, that a cache pays where it removes a path, pointed here. A site's cache holds own
slots (shape -> slot) and one absent record; the location cache and the method caches serve sized
instances. A plain receiver whose property lives on its prototype had nothing: every read missed
in line and took the slow read, which probed the site's own entries, the absent table, the
registry (`class_field_lookup`, a call), the receiver's own map (`prop_find`), the sized
inherited cache, then walked the chain with a lookup on each link (`lookup_prop_chain`). vue's
reactive array iteration reads a native array iterator's `next` this way on every step (1.28 M
reads per run, `--rt-stats`' `pic_ool_get: inherited`), and so does any `Object.create` or ES5
instance's method.

`g_proto_read_cache` (2,048 entries, direct-mapped by (receiver shape word, key)) records the
direct prototype that holds the key as a boxed data slot: {shape, key, epoch, holder shape,
slot, holder}. A hit needs the receiver's shape word (it fixes the receiver's keys, so the key is
not its own; a dictionary receiver is never recorded), its prototype the recorded cell (compared,
never followed: a hit reads the receiver's live prototype, so a dead holder whose address was
reused by another object of the same shape is still read correctly), that cell's shape word (its
keys and attributes: the slot still holds the property as data) and the addition epoch (relinks,
definitions on prototypes, class registrations, full collections move it). The slow read fills it
after its walk found the key one link up (`proto_read_fill`: both shaped plain objects, the slot
neither an accessor nor an integer slot) and sets the site's `TS_PIC_INHERITED_FLAG` (a bit of
`absent_depth`, whose depth mask is now 0x3f); the leaf read (`ts_get_pic_checked`) probes the
table for a plain receiver only at a flagged site, after the absent record, so a site that never
read an inherited property pays one byte test on its misses (tsc-ts's polymorphic own reads).
`Reflect.get(t, k, r)` on a shaped plain target with a key that carries its id (a trap's key) or a
symbol reads an own data slot (`prop_find`) or the table without the roots, the registry test and
the walk (vue's get trap on every reactive read). `TSAOT_PROTO_READS=0` fills nothing.

### S2. Prototype validity cells (private prototype shapes)

An object that becomes a prototype (`TS_HDR_IS_PROTO`: a class's or builtin's prototype at
birth, `ts_set_proto`, `Object.create`, the ES5 `new`) takes a **private shape**: a fresh shape
id with its own vectors and edges (a transition from a private shape is private too), so the
shape word identifies the prototype object as well as its keys, and the shape descriptor can
carry the object's **cell** (`g_shapes[sid].cell`, an epoch) and its **users** (the private
shapes of the prototypes whose prototype it is, registered when a prototype's link is made).

Invalidation: a private shape's transition (a key added, deleted, an attribute changed) moves its
users to the child shape and bumps the users' cells recursively; a relink of a prototype bumps
its own cell and its users' recursively; dictionary mode (shape 0) bumps and drops the users.

An absent or inherited entry (the site record, the stub cache) then validates by the receiver's
shape word, the receiver's prototype's shape word (identity and keys in one compare) and that
shape's cell: three compares, no chain walk, no depth limit. A receiver whose prototype's shape is
public (a link site that never set `TS_HDR_IS_PROTO`) is not recorded: a missed site costs the
cache, never a wrong value, which is what makes this safe where the per-key bits of option A in
`docs/absent_reads_inline_design.md` were not. Young prototypes are recorded only once old (a
holder may move; the cell lives in the shape, the holder reference in the entry does not).
Knob `TSAOT_PROTO_CELLS=0`. Expected: the chain walks of every absent and inherited hit
(`prop_absent_lookup`'s depth loop, `sized_inherited_cached`'s holder check stays), tsc-ts's
`SymbolLinks` pattern.

### S3. Dynamic keys

`o[k]` sites already reach the named cache through the key id (`ts_get_dyn_pic_checked`); with S1
a megamorphic keyed site answers from the stub cache. The rest: `Reflect.get(t, k, r)` takes a
site cache from the emitter (`ts_reflect_get_recv_pic`), answering a data property on the
target's own map or a prototype holder without the receiver (a getter runs with the receiver and
keeps the generic path), and `k in o` probes the stub cache for an OWN / INHERITED / ABSENT
entry. Exporter and emitter: the site cache for `Reflect.get` and `in`.

### S4. One map word

A sized instance's `shape` word is 0 today; its layout is the class registry's. Giving it a shape
of its own (`TS_SHAPE_CLASS_BASE + class index`, the class's fields as the key vector with a
kind byte per slot: every field is 8 bytes, so slot i is byte offset `sizeof(ts_sized_head) +
8 i`) makes a class instance a shaped object with in-object slots: one inline probe for both
kinds (the entry's slot word already carries a kind byte), one stub cache, one absent and
inherited path, and a polymorphic interface site (`activeSub.deps` over ReactiveEffect and
ComputedRefImpl) pays one compare and one load per entry, as a map compare does. Own dynamic
properties of an instance (the sidecar) are the external slots of a transition from the class
shape. This is the largest change (every reader of a sized instance's `shape`, the registry's
caches, the emitted inline helpers) and comes last, when S1-S3 have taken what the current model
gives.

## Order and measurement

S0 (exporter, small) with S1; then S2, S3, S4. Each: design note here, the fixtures above, the
A/Bs, the gates, a `docs/TODO.md` entry. The target is V8's time on the real projects' dynamic
phases (vue's reactivity phase: 847 ms against Node's 527 before S1).
