# A sized instance's field in the per-site inline cache (session 352, slice AJ)

## The cost

A property read or write through a dynamic site (`x.kind` with `x: any`, or
every field access of a class that dispatches dynamically) consults the site's
inline cache. The per-site cache (`ts_prop_ic`, four entries of shape word and
slot) serves plain shaped objects in line; a sized class instance has no shape
word (`TS_SHAPE_NONE`), so every one of its reads left the inline path and
went to `ts_get_pic_checked_slow`: the absent-site record, the negative cache,
the own-slot probe, then a bounded global table of struct locations keyed by
the site's address (`g_prop_locations`), then the class registry's field cache,
then the fill. tsc-ts compiled with every class dynamic (the extractor's
`TSAOT_DEBUG_ALL_UNSTABLE=1`) spent 60% of its 12.5 s in that path:
`prop_ic_probe` 21%, `ts_get_pic_checked_slow` 19%, `class_field_lookup` 6%,
`prop_find` 5%, the fills 3%.

## The entry

A sized instance's class word names one layout for the program's run: a class
registers its layout lazily (its first use), which adds words, but a registered
word's layout never changes, and an instance the program relinked carries
`TS_CLS_RELINKED` in its word. So a per-site entry can hold the class word tagged with
`TS_PIC_SIZED_TAG` (bit 31; a shape id never has it) in its `shape` field,
and the struct offset with the slot's kind (boxed, double, int32) in its
`slot` field. The out-of-line read probes the four entries for the tagged
word and the key before anything else, and reads the slot by its kind,
boxing a double or an integer; the out-of-line write stores a boxed or
double slot of an instance with no integrity bit (an int32 slot's exactness
check, a frozen or sealed instance, and everything else take the paths that
follow). The out-of-line read
and write fill the entry where they fill the global location table, so a site
that sees one or a few classes is in line from its second access on.

Semantics are the registry's: the same offset and kind the descriptor path
reads and writes, the same barrier for a boxed store. A relinked instance
misses the entry (its word differs) and takes the registry path, which knows
its allocation class's layout; an instance with own dynamic properties keeps
its struct fields where they are, so the entry still answers correctly for
them (the sidecar holds only the added properties).

## Where the probe runs

Not in line. The first version probed the four entries in the inline read and
write after the shaped probe failed, and the typed tsc-ts build, whose dynamic
sites are almost all plain-object sites, ran 0.6% more instructions and 0.8%
more cycles: the probe's code at thousands of sites, executed on every inline
miss, outweighed the few sized receivers it served; a per-site flag that
skipped the loop did not recover it. The probe now runs at the head of the
out-of-line read (`ts_get_pic_checked`, after the absent-site record) and
write (`ts_set_pic`), so the inline functions and the typed program's code are
exactly what they were, and a dynamic program's sized receiver pays the call
but none of the slow path behind it. The site's flag (the top bit of its
absent-depth byte, `TS_PIC_SIZED_FLAG`; the depth is at most 3, and
`ts_prop_ic` keeps its 80 bytes) still spares plain-object sites the four
compares.

## Measurements

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic (`TSAOT_DEBUG_ALL_UNSTABLE=1`), wall | 12.5 s | 8.9 s (-29%) |
| tsc-ts typed, one checker, instructions | 23.65 G | 23.62 G (-0.1%) |
| tsc-ts typed, cycles | 5.466 G | 5.481 G (+0.3%, within the run-to-run band) |

Outputs byte-identical in both (the all-dynamic build's against the typed
build's). The dynamic compile's remaining time is in the sites that see many
classes (megamorphic: the four entries cannot hold a `node.kind` over hundreds
of node classes) and take the generic path; a global cache keyed by class word
and key for those is the natural next step.

## At a class-typed site (slice AK)

A field access whose receiver the program types as a class instance, in a
class that dispatches dynamically (`struct_direct_offset` has nothing for an
unstable class), went through the shaped inline cache like an `any` access,
and such a receiver never hits the shaped probe: every access was an
out-of-line call. The emitter now gives such a site `ts_get_sized_pic_inline`
/ `ts_set_sized_pic_inline` (and their lazy-frame forms): the sized probe in
line, the cached read or write on a miss. A typed program whose classes are
stable never emits them, so its code is unchanged; a dynamic program's class
field accesses are in line from their second execution. Knob
`TSAOT_SIZED_PIC_INLINE=0` (the parity oracle's output). Sites of functions
with register homes (`lazy_homes`) keep the previous path.

With it, a site over many classes reaches the megamorphic state: evicting a
live entry of a sized receiver from the location table now counts as a miss
whatever its key (same-key evictions were never counted, so `node.kind` over
hundreds of node classes refilled the table forever), and after sixteen the
site takes the generic read, whose first step is the registry's field cache.

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 8.9 s | 8.1 s (-9%) |
| tsc-ts typed, one checker, instructions | 23.61 G | 23.61 G |

Outputs identical in both. What remains of the dynamic compile's lookups is
the megamorphic sites' path: the registry's field cache (`class_field_lookup`,
12%), reached through the slow path and the generic read (11% and 5%); a
shortcut from the out-of-line entry straight to that cache is the next step.

## The megamorphic site (slice AL)

A site over many classes (`node.kind` over hundreds of node classes) holds no
useful entry; once megamorphic its reads went out of line to the slow path,
then to the generic read, then to the registry's field cache: three calls and
the generic read's dispatch (a proxy test, the kind ladder) for one cached
offset. The out-of-line read and write now test the megamorphic flag first
and, for a sized receiver, go straight to `class_field_lookup` and the slot
(the write refusing a frozen instance as the struct path does). Other
receivers and a miss in the registry's cache take the paths as before.
Fixture `classes/megamorphic_field_sites` (twenty-four node classes read and
written through `any` at the same sites, with a frozen instance, an instance
with own properties and a plain object in the mix).

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 8.1 s | 7.45 s (-8%; 12.5 s before slice AJ) |
| tsc-ts typed, one checker, instructions | 23.58 G | 23.59 G (+0.07%) |

Outputs identical in both.

## The registry's cache by class word (slice AM)

`class_field_lookup`, the registry's field cache, was the megamorphic path's
remaining cost (11% of the all-dynamic compile): keyed by the prototype and the
key, each probe read the receiver's prototype through `layout_proto_of` (a
relink test and a registry read for relinked words), hashed it, and tested the
receiver's size. A second cache in front of it is keyed by the class word and
the key: a word names one layout for the run, so a hit needs no prototype
read, no hash of a pointer and no size test, and a relinked instance (its word
carries the flag) or a word outside the index takes the prototype-keyed path
as before. The entries carry the layout epoch; a registration invalidates them.

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 7.45 s | 7.29 s (-2%) |
| tsc-ts typed, one checker, instructions | 23.61 G | 23.61 G |

Outputs identical in both. The dynamic compile's remaining cost has moved to
its method calls: the two cached reads of a dynamic call (the own property,
then the prototype method), each out of line for a sized receiver, and the
generic call entry.

## The method of a dynamic call (slice AN)

After slices AJ to AM the all-dynamic compile's remaining cost is its method
calls. A dynamic call (`CalleeRef::Method` the devirt pass could not resolve)
read the method value twice through per-site caches: the own property under
the field key (a function stored in a field, or an object literal's method),
then the prototype method under the method key, each read a call into the
runtime for a sized receiver, and a site over many classes ran each read's
megamorphic path. The runtime now resolves the method of a sized class
instance in one call, `ts_method_lookup_sized`: the own property through the
registry's cache by class word (slice AM), the instance's sidecar when it has
one, then the prototype method through a cache keyed by the class word and
the method key that remembers the prototype object holding the method, that
object's shape word and the slot. A hit re-reads the slot, so a method
replaced in place is followed; a method deleted or redefined changes the
holder's shape and misses; a relinked instance (its word carries the flag), a
relinked prototype anywhere in the program (`g_class_relinked`), an accessor
and a dictionary-mode holder take the full chain lookup. A receiver that is
not a sized instance takes the two cached reads as before. The emitter uses
the entry at a call whose receiver the program types as a class instance (not
the dynamic sentinel class); `TSAOT_METHOD_SIZED_CACHE=0` keeps the two
reads (the parity oracle's shape).

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 7.29 s | 5.57 s (-24%; 12.5 s before slice AJ) |
| tsc-ts typed, one checker, instructions | 23.62 G | 23.57 G (-0.2%) |

Outputs identical in both.

## The megamorphic site in line (slice AO)

After slice AN the all-dynamic compile's profile is the megamorphic field
read itself: the registry's cache by class word (15% of samples), the
out-of-line read in front of it (10%), and the inline probe's four-entry scan
in the generated code before them (the one function visiting every node kind
is 10% of samples with each of its hundreds of sites scanning and missing).
A megamorphic class-typed site now reads the registry's cache by class word
in line: the inline read and write test the site's megamorphic flag first
(the flag the four-entry scan tested anyway) and probe the global table,
whose slot for a class word and a constant key is one multiply, one xor and a
mask; a hit reads or writes the slot as the out-of-line path would (a plain
value, a double, or an integer slot read as a number; a write of a non-number
to a numeric slot and a frozen receiver take the out-of-line path). The
table and the key hash move to the header for that; the runtime's lookup
keeps filling the table on a miss. A monomorphic site is unchanged: its
first test is the same flag.

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 5.57 s | 5.45 s (-2%) |
| tsc-ts typed, one checker, instructions | 23.55 G | 23.55 G |

Outputs identical in both.

## A negative entry answers in line (slice AP)

The registry's cache by class word remembers that a class has no such field
as well, but only its out-of-line lookup read that answer: a dynamic method
call's own-property probe (a method is seldom a field) and the out-of-line
read and write's megamorphic shortcut each paid the call, the size test and
the hash for a negative entry that was already there. The header's probe now
returns the valid entry found or not, so those three paths answer "no such
field" in line and call the lookup only when the table holds no entry.

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 5.45 s | 5.34 s (-2%) |
| tsc-ts typed, one checker, instructions | 22.73 G | 22.72 G |

Outputs identical in both.

## The dynamic call's method in a per-site cache (slice AX)

After slices AN to AP the all-dynamic compile's profile put
`ts_method_lookup_sized` at 10% of its samples: every dynamic method call on
a class instance probed the registry's cache for an own field, tested the
sidecar, hashed the class word with the method key, compared the holding
prototype's shape and read the slot. A call site is usually monomorphic or
nearly so in its receiver's class, so the site keeps a cache of its own
(`ts_method_site_ic`, static in the generated code as the property caches
are): the receiver's class word, the prototype holding the method, that
holder's shape word and the slot. The inline path (`ts_method_lookup_sized_ic`)
compares the class word (an unrelinked instance of one layout), tests
`g_class_relinked` and the instance's sidecar pointer (an own property could
shadow), compares the holder's shape (a deleted or redefined method changes
it; a replaced one keeps it, and the slot is re-read) and takes the slot's
value when it is a function. The runtime's lookup fills the site on a
prototype-method hit, and only for a class with no field of the method's
name (a field assigned later must shadow: such a class keeps the lookup);
an accessor in the slot, a receiver through a proxy, a dictionary holder and
every miss take the lookup as before. `TSAOT_METHOD_SITE_IC=0` keeps the
lookup alone (the parity oracle). Fixture `classes/method_site_cache`.

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 5.07 s | 4.76 s (-6%; 12.5 s before slice AJ) |
| tsc-ts typed, one checker, instructions | 22.52 G | 22.49 G |

Outputs identical in both.

## The dynamic call itself in line (slice AX2)

With the method in hand, a dynamic call went through `ts_call_method` and
`ts_call`: a proxy test, a function test, the `takes_this` test, the
environment test, then the generic entry. For a class method (it takes its
receiver as the first argument and carries no environment), the inline
`ts_call_method_inline` reads the two bytes of the function cell and calls
the generic entry directly; a bound or environment-carrying function, a
proxy and anything else take the runtime's call as before.
`TSAOT_CALL_METHOD_INLINE=0` keeps the call (the parity oracle).

| program | before | after |
|---|---|---|
| tsc-ts, every class dynamic, wall | 4.80 s | 4.54 s (-5%; 12.5 s before slice AJ) |
| tsc-ts typed, one checker, instructions | 22.50 G | 22.44 G (-0.3%) |

Outputs identical in both.

## A dynamic class keeps its instanceof interval (slice AY)

`instanceof` against a class that dispatches dynamically took the chain
walk (`ts_instanceof`, 1.6% of the all-dynamic compile's samples) because a
class's interval (docs/class_index_dispatch_design.md) was given only to a
subtree of stable classes. A dynamic class keeps its interval when its
instability leaves the prototype chain alone: a replaced prototype method, a
dynamic or computed member, a deleted member, a constructor returning another
object, the debugging modes. A reassigned prototype object (`C.prototype =
...`, an ES5 constructor's) or a foreign base keeps the chain walk, and a
relinked prototype anywhere raises the guard the interval test already
carries. The vtable dispatch keeps its own, stricter notion (stable classes),
and a typed program's generated code is unchanged (its classes are stable).
Fixture `classes/instanceof_dynamic_classes`.

Two companions were measured and not kept: the receiver check of a dynamic
method call in line (two tag tests at every site, the throw out of line) cost
the typed compile +0.2% instructions at its 1,325 sites for a gain inside the
dynamic measurement's noise; and the generic inline property caches trying
the registry's cache by class word on a megamorphic miss cost +0.9%
instructions at 5,600 sites, likewise for no measurable gain. The out-of-line
entries keep those sites.
