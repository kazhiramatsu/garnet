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

## The interface-typed site (Session 355)

vue's reactivity core reads and writes its subscriber and link nodes through interfaces
(`activeSub.depsTail`, `link.version`, `sub.flags`: `Subscriber` is implemented by ReactiveEffect
and ComputedRefImpl, `Link` is a class), and the exporter's class hint, which needs one stable
class, does not apply to an interface: those sites took the generic inline read and write, whose
probe is the plain-object one, so every access of a class instance missed it and paid the
out-of-line call (`ts_get_pic_checked` 8% of the run's samples, `ts_set_pic` 2.6%, the inherited
and registry lookups behind them 3%). The experiment of this slice, the sized try after the
plain-object probe at every generic site, took vue from 39.12 to 37.11 G instructions (-5.1%,
1,347 -> 1,300 ms) and the typed compiler from 22.19 to 22.48 G (+1.3%, the flag test on each of its
many inline misses), as "Where the probe runs" measured before.

The site is chosen statically. The exporter marks a `LoadField` / `StoreField` `sized` when the
receiver's static type (narrowed, without null and undefined; a type parameter by its constraint)
admits a class instance without naming one stable class: a class type without a hint, or an
interface, type literal or union that some class of the program is assignable to
(`receiverAdmitsClassInstance`, `checker.isTypeAssignableTo` over the program's classes, cached by
type). A marked site takes `ts_get_pic_checked_inline_sized` / `ts_set_pic_inline_sized` (and the
lazy-frame forms): the plain-object probe first, then `ts_get_sized_pic_try` / `ts_set_sized_pic_try`,
the entries the out-of-line path filled by class word, then the call. A site whose type admits no
instance (`any`, an array, an interface only object literals satisfy) is exactly what it was.
`TSAOT_SIZED_SITES=0` marks no site.

| program | before | after |
|---|---|---|
| vue, instructions | 39.11 G | 37.00 G (-5.4%; 196 read and 47 write sites marked of 2,300 generic ones) |
| vue, wall (alternating, Node 762 ms) | 1,343 ms | 1,276 ms (-5.0%; 1.76x -> 1.68x of Node) |
| tsc-ts typed, one checker, instructions | 22.122 G | 22.115 G (2,304 sites marked in 21 units: no cost) |

Outputs identical throughout.

## The site cache at an interface-typed call, and a field-held method (Session 358)

A dynamic call whose receiver the program types as an interface or `any`
(hono's `router.match` through `Router<T>`, SmartRouter's delegation) took
the two cached reads (`emit_method_value_lookup`): the plain-object probe in
line, then `ts_get_pic_checked` out of line for a sized instance, where the
inherited and absent caches are hashed before the site's sized entry is
read, and twice for a prototype method. Such a site now holds a
`ts_method_site_ic` as well (`ts_method_lookup_dyn_ic`: the plain-object
probe in line as before; a sized receiver then takes
`ts_method_lookup_dyn_fill` out of line, the cache first and the lookup
after, and any other receiver the two cached reads as before. A first cut
sent every receiver through the out-of-line entry: tsc-ts's checker is a
dictionary-mode object literal whose methods the inline probe never serves,
and the extra call at its sites cost 0.2% of the compile's instructions.)
The cache's second kind, `TS_MSIC_FIELD`, is the
receiver's own struct field holding the function: the class word (the
layout, so the offset; an instance that abandons its layout clears the word)
and the byte offset, and a function in the slot. Nothing in the sidecar can
shadow a struct field and a field becomes neither read-only nor an accessor,
so the hit needs no sidecar test. The lookup fills it when the field's value
is callable (hono's `match`, a field each router reassigns with its closure),
where before a class with a field of the method's name kept the lookup on
every call. The lookup's prototype walk tries the field key before the method
key at each link (an accessor or an assigned property at a nearer link, the
class's method otherwise), as one JS namespace resolves closest first; it
walked the method key alone, which missed a getter in the method position
through an `any` receiver and a subclass's getter over a base method.
`TSAOT_METHOD_SITE_IC=0` keeps the two reads (the parity oracle). Fixture
`classes/method_site_cache_dyn`. hono's RegExpRouter 72.1 -> 68.1 ms and
SmartRouter 94.8 -> 81.8 (Node 39 / 42); vue 1,056.4 -> 1,055.0 ms (seven alternating rounds each, medians; outputs identical; Node 773); tsc-ts 22.183 -> 22.182 G instructions (unchanged; outputs identical).

## The known callees of a dynamic call (Session 358)

`known_method_closures` guessed one callee for a dynamic method call: the
field keys under which the program stores exactly one closure, verified at
the site by the function cell's code pointer and taken through the direct
entry with the closure's cells. hono's `router.match` stores three kinds under
`match` (the module function through the field initializer, the closure the
first call makes, SmartRouter's bound function), so the key was poisoned and
the driver's site took `ts_call_method` -> `ts_call` -> the generic entry ->
the direct entry on every call: the paste's "call through the `match` function
value", which V8 inlines into the loop. The guess is now a set
(`known_method_candidates`, `KnownCallees`): every function the program stores
under the key, through copies and through a load from a module binding's cell
that holds one closure (the field initializer's `match = match`), up to
KNOWN_CALLEE_MAX (4); a key with more is megamorphic and gets none. The site
fetches the method value as before (the sized or the dynamic site cache), then
compares the code pointer with each candidate's (`emit_known_callee_guards`)
and takes the direct entry; a bound function of a candidate with no partial
arguments (`ts_bound_thunk` with a two-entry env: SmartRouter's
`router.match.bind(router)`) is unwrapped the same way, the target's cells and
the bound this; any other value takes the runtime's call. Correctness never
depends on the set's completeness. The classes' methods of the name were tried
as candidates too and not kept: `ts_call_method_inline` already enters an
environment-free method's generic entry directly, and the direct call let the
C compiler inline hono's PatternRouter.match into the driver's loop (8%
slower). `TSAOT_KNOWN_METHOD=0` keeps the lookup alone (the parity oracle);
`TSAOT_KNOWN_CALLEE_DEBUG=1` prints the sets at emission. Fixture
`classes/known_callee_guards`. hono, five alternating rounds (medians; Node):
plain: TrieRouter 244.5 -> 244.6 ms (260), RegExpRouter 68.6 -> 64.2 (39), PatternRouter 245.2 -> 241.5 (153), SmartRouter 81.4 -> 72.0 (42); trained (each side's own training): TrieRouter 179.2 -> 178.5, RegExpRouter 47.1 -> 46.5, PatternRouter 149.0 -> 146.1, SmartRouter 55.2 -> 50.1; outputs identical. tsc-ts 22.180 -> 22.181 G instructions (unchanged; outputs identical; 660 sites carry guards); vue 1,048.7 -> 1,051.1 ms (seven alternating rounds each, medians; outputs identical; Node 773; 702 sites carry guards).

## The candidate classes in line (Session 361)

**Finding.** After Session 361's runtime slice vue's `Dep.track` is the largest gap to V8 (about 69
ms of an 890 ms run against 23), and 37% of its samples fall on five interface-typed accesses:
`activeSub.deps` and `activeSub.depsTail`, read and written (`Subscriber`, implemented by
ReactiveEffect and ComputedRefImpl). Each takes `ts_get_pic_checked_inline_sized`: the plain-object
probe, which fails at the shape test on a sized receiver, then `ts_get_sized_pic_try`, which reads
the site's flag byte, the receiver's flags and class word, and compares up to four entries (word
and key): some 20-25 instructions and six dependent loads, where V8's polymorphic cache compares a
map and loads a field per entry. The exporter already knows, through the checker, which program
classes a value of the receiver's type can be an instance of; the emitter knows each class's
struct layout and class interval. The generated code can test those classes itself.

**Exporter.** In `withClassHint`, a site marked `sized` through `receiverAdmitsClassInstance` (no
class hint) also records `cands`: the ids of the program classes whose instance type is assignable
to the receiver's non-nullable type (a type parameter by its constraint), all of them when there
are at most 32, none past that; cached per type, as `admitsClassCache` is. The bound is not the
number of tests: the emitter reduces the set to the classes declaring the field, so a union of many
subclasses of one base (an AST's node type) is one test. The set is a guess the site tests, never
a claim: a generic class's declared type is not assignable to an instantiation of its interface and
is simply not a candidate there. `TSAOT_SIZED_CANDS=0` records none.

**IR.** `cands: Vec<u32>` on `LoadField` and `StoreField` (`#[serde(default, skip_serializing_if =
"Vec::is_empty")]`); `sroa.rs` copies it (the CLAUDE.md rule for new IR fields, and the `tests/*.rs`
literals).

**The class word of every cell.** The test reads `cls` before it knows the cell's kind, and an
interface-typed site, unlike a class-typed one, can honestly see any object: an array, a Map, a
generator, a Proxy, a symbol through a cast. Every kind embedding `ts_obj_common` has word 0, but
three did not embed it and held other bytes at that offset: a Proxy the low half of its handler's
tagged address (a heap address whose low 32 bits are small is a class index), a Symbol its
`registered` byte (`Symbol.for` read as class index 0), a coroutine the low half of its resume
function. The class-typed interval guards and `ts_typed_outside` had the same exposure. These
structs now keep the class and shape offsets zero (`cls, shape` members that nothing writes;
`gc_alloc` zero-fills) with a `_Static_assert` each: a Proxy cell was already at least
`sizeof(ts_object)`, a coroutine rearranges within its size, a Symbol grows from 32 to 48 bytes.

**Emitter, reads.** `candidate_fields`: for each candidate, the topmost ancestor declaring the
field as a struct field (`declaring_class`, `hint_guard`'s rule), deduplicated, kept only with a
class interval (`class_ranged`); none at all past four such classes (`CAND_FIELDS_MAX`: a site with
more is megamorphic and its cache's class-word table serves it). The read becomes

```c
if (ts_is_obj(o) && (uint32_t)(((ts_object*)ts_ptr(o))->cls - lo1) < span1) { dst = ((ClassD1*)ts_ptr(o))->fK; }
else if (ts_is_obj(o) && (uint32_t)(((ts_object*)ts_ptr(o))->cls - lo2) < span2) { dst = ((ClassD2*)ts_ptr(o))->fK; }
else { <the site's cached read, unchanged> }
```

The interval test needs no `g_typed_slow` gate (`receiver_guard`'s `Range` note): an index in the
interval is a sized, unrelinked instance of the declaring class or a subclass, whose struct starts
with the declaring class's layout; a plain object's `cls` is 0, an instance converted to a
dictionary (a deleted field) has 0, a relinked one carries `TS_CLS_RELINKED`, and a field cannot
become read-only or an accessor on an instance (`sized_field_attr_set`'s note). Each value goes to
the destination as the hinted read's does (`set_val`, `set_num`, `set_int_or_num`).

**Emitter, writes.** The same chain, each test with `!ts_store_frozen(o)` where the program can
freeze instances (`frozen_tests_on`): a boxed field takes any value and the barrier
(`ts_write_barrier_hdr`, as the hinted store); a number field takes an unboxed local, or a boxed one
behind `ts_is_num`; an integer slot the same, through the runtime's integer rule in line
(`ts_int_field_value_k`, which `infer_int_store_fields` assumes of receiver-less stores: an integer
or a TypeError naming the field; 30 M `c.n = c.n + 1` through an interface were 7x the double
field's time at the site's write, and vue's `sub.flags |= ...` is such a store). A frozen instance
and everything else take the site's write, unchanged.

**One struct per field** (`field_struct`). The chain reads `((Decl*)p)->fK`, the declaring class's
struct; the review of this slice found that a class-typed access at the same field used the
receiver's class, `((Sub*)p)->fK`. The class structs are flat, a subclass's does not contain its
parent's, so for clang's struct-path TBAA those are two unrelated objects: `o.value` (a subclass) read
after `h.value = x` kept its old number, a silent stale read. The same held between two class views
long before this slice (`o.x = 1.5; b.x = 2.5; return o.x;` with `o: Sub`, `b: Base` answered 1.5).
Every field access, and the allocation's undefined and zero fills, now go through the declaring
class's struct, so one field has one view and the analysis's facts are true, keeping what TBAA gives
(two fields, of one struct or of two classes, stay apart). `-fno-strict-aliasing` or `may_alias` on
the structs would have thrown that away. The class word is written through the class's struct
(`header.cls`) and tested through `ts_object*`, two views again, but of one pointer: an access through
the same SSA value is a must-alias before TBAA is asked, and a load through another value (a phi) does
not leave its block, so the test sees the store; nothing reproduced there.

**Covered and not.** The chain wraps the cached access as statements, so a lazy-home function (whose
reads are statement expressions) and a site with a static-slot hint are covered too. A method read
(`sub.notify()`) is not a field and keeps the dynamic call's caches. The candidates are tested in
class id order; a profile-guided build could order them by the site's sized entries.

**Fixture** (`classes/interface_candidates`, in the GC stress list; `sized` needs the strict
profile, so `TSAOT_CONF_STRICT=1` is the mode that exercises the tests, 155 sites here): an interface
implemented by two classes with the field at different offsets, a subclass of one, a third class
implementing it with accessors, a plain object satisfying it, an instance relinked by
`Object.setPrototypeOf`, a frozen instance's write (TypeError), sealed and non-extensible instances,
an instance whose field was deleted, an object made from a class's prototype, number and integer
fields read and written, a Proxy of an instance and a revoked one, null, undefined and primitive
receivers, a union of ten subclasses of one base, and arrays, strings, functions, typed arrays, a
Map, a Set, a Blob, an Error, a RegExp's `lastIndex`, a generator, array and Map iterators, a
Promise, a Date, a WeakMap, an ArrayBuffer and symbols at sites that test classes. `classes/field_one_view`
pins the two views of one field in both modes (it fails on every line without `field_struct`).

**Measured** (alternating, outputs identical, r27 -> r28; Node in parentheses): vue 895.5 -> 873.4 ms
(about 750), hono_app 123.7 -> 124.6 (155), TrieRouter 209.1 -> 208.8 (250), RegExpRouter 53.4 -> 54.4,
PatternRouter 234.7 -> 238.4, SmartRouter 54.6 -> 55.6; tsc-ts 21.865 -> 21.979 G instructions (+0.52%),
cycles +1.33%, wall 1.14 -> 1.15 s. hono's binaries are the same with or without `field_struct` and the
wider freezer scan, so the routers' 1-2% is the reassigned locals' guards and code placement; tsc-ts's
half a percent came with the review's fixes (the slice alone was 1.0000): a reassigned local's accesses
take a guard they never should have skipped. vue's binary +3 KB, tsc-ts's +7 KB.
