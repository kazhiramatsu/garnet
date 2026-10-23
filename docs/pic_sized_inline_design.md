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
