# The cell header at 8 bytes (H1), and sized instances without dynamic-property fields (H2)

Session 352. Status: design for H1, revised after a review (Codex,
gpt-6.1-sol at xhigh effort: one blocking, three major and one minor
finding), a second (two blocking, two major) and a third (one blocking,
one major, nothing minor), all answered below; H1 built in two commits
("H1 as built", below); H2 sketched. Runtime (`ts_rt.c`, `ts_rt.h`),
emitter (`emit_c.rs`), the frozen emitter's templates
(`analyzer_ts/src/emit.ts`, `emitc.ts`: the minimal fix the frozen-source
rule allows, as for D3). Follows `docs/gc_v2_design.md` §4.4 and §6.8.2
(D3: 32 bytes to 16). Comes before the threads work
(`docs/threads_design.md`): milestone A holds one program per checker, so
what a cell saves is saved once per checker.

## Why

Every live old cell at the end of a run, in its size class (statistics
build with a measurement walk that computes each cell's class bytes now
and with 8 fewer requested bytes, Session 352; payloads not included):

| | cells | bytes now | 8-byte header (H1) | H1 and H2 (24 bytes) |
|---|---|---|---|---|
| tsc-ts | 3.85 M | 503 MB | -35.4 MB (-7.0%) | -94.1 MB (-18.7%) |
| the TypeScript compiler | 4.03 M | 579 MB | -30.9 MB (-5.3%) | -31.0 MB |

A cell's saving is `capacity(request) - capacity(request - 8)`: within the
16-byte classes (up to 256 bytes) a request of 8 modulo 16 drops a class and
one of 0 modulo 16 does not (arrays at 112 bytes and Maps at 128 keep
theirs; objects and class instances with an even number of 8-byte fields,
functions, Sets, typed arrays shrink; strings shrink when their residue is
1 to 8); above 256 bytes the classes widen by about an eighth, so a few
cells save more and most nothing. Exit-live cell bytes are not peak RSS:
the A/B measures peak memory. tsc-ts's peak is 812 MB, so about 4% for
H1 and 12% with H2; H2 matters for programs built of class instances
(2.82 M of tsc-ts's 2.82 M live objects are sized instances; the
compiler's long-lived objects are plain objects made by constructor
functions). Time: 32 more header bytes per object cost tsc-ts 0.9%
(Session 351), so expect a few tenths of a percent from H1.

## H1: the header

```c
typedef struct ts_gc_header {
  uint8_t kind, mark, gen;
  uint8_t flags;            /* TS_HDR_REMEMBERED (bit 0), TS_HDR_SIZED (bit 1) */
  union {
    uint32_t pin_word;
    struct { uint16_t spare; uint8_t inline_cap; uint8_t hdr_spare; };
  };
} ts_gc_header;             /* 8 bytes, asserted */
```

`spare` keeps the allocation site id (`docs/site_pretenuring_design.md`).
The `remembered` byte becomes `flags`: bit 0 keeps its meaning (every
enrollment, reset, promotion and sweep masks it and leaves bit 1 alone),
bit 1 marks a sized class instance. Cells stay 16-byte aligned and a body
starts at offset 8, which every member allows (pointers, doubles, `tsv`,
coroutines' `jmp_buf`s; the review checked the layouts with Clang); the
bitmap and run arithmetic works on cell starts and size classes, not on
the header's length.

**A sized instance's extent.** Its struct size, in words after the
`ts_object` header, lives in `inline_cap` (low byte) and `hdr_spare` (high
byte): up to 65,535 words (module records are the largest classes: 1,399
fields in tsc-ts, 2,428 in the compiler, more than one byte holds). A plain
object keeps using `inline_cap` for its in-object slots and `hdr_spare` for
its remembered card range; `TS_HDR_SIZED` says which reading applies.
`delete`'s conversion of an instance into a plain object
(`obj_abandon_layout`) already reads the struct area as in-object slots: it
clears the flag and keeps the words as `inline_cap` (it refuses areas above
255 slots today, so the high byte is then 0), after which its card write is
a plain object's.

**Nothing else may write those two bytes of a sized instance.** `hdr_spare`
has twelve writers today (`ts_rt.c` 1111, 1128, 1142, 1148, 1151, 2465,
5699, 5761, 12187, 12292, 12300, 12349): the remembered-slot protocol, the
remembered set's resets after a minor and a full collection, and defensive
`0xFF` stores in `obj_to_dictionary`, both `delete` entry points and
`props_delete_own`, several of them before any check of the object (the
second review found four that the first draft missed: an absent or refused
`delete` would have rewritten an old instance's extent). All of them go
through three helpers (`gc_cards_all`, `gc_cards_merge`, `gc_cards_reset`)
that leave a sized instance's bytes alone and remember it whole, and a gate
check (`tests/header_bytes_gate.sh`, run by the unit gate like the
inline-policy gate) fails on any other assignment to `hdr_spare` or
`inline_cap` in the runtime or the emitters. `ts_write_barrier_at` and
`ts_write_barrier_ptr` remember a sized owner whole instead of deriving a
slot from `inline_cap`; `gc_mark_common_props` scans a sized instance's
dictionary entries without the card window (there are rarely any; its
struct fields are scanned whole by `gc_mark_class_fields`).

**A sized instance is never shaped.** Heap instances start with
`TS_SHAPE_NONE`; the Rust emitter initialized stack instances and their
stack-check copies with `TS_SHAPE_EMPTY` whenever property caches are on
(production), and a property added to one would have taken the shaped path
and read the extent's low byte as in-object slots, overwriting fields (the
second review; parity disables the caches, so text parity cannot see it).
They start with `TS_SHAPE_NONE` too (the frozen emitter already writes 0).
Shapes change only from shaped states, and `ts_obj_adopt_layout` refuses
sized instances and anything not `TS_SHAPE_EMPTY`; the other readers of
`inline_cap` (`ts_obj_slot_ptr`, the slot growth of property additions,
the slot statistics) are shaped paths.

**The encoding is checked.** `ts_hdr_init_sized(h, bytes)` aborts with a
message when `bytes` is below `sizeof(ts_object)`, not a multiple of 8 past
it, or more than 65,535 words (`ts_sized_extent_words`): class
registration (`ts_register_class_meta`) checks every instantiated class's
size at startup, before any instance exists, and the public `ts_new_sized`
passes through the same check, which replaces the clamp to
`sizeof(ts_object)`; a stack instance's call folds it at compile time. (The
draft's static assertion per class struct would have needed the frozen
emitter's templates too, beyond the minimal fix.)

**A header-only instance stays unsized.** An instance of a class without
struct fields (a stack instance, or a heap one under
`TSAOT_EMPTY_CLASS_PLAIN=0`) has an extent of 0 words; today its size
equals `sizeof(ts_object)` and `ts_obj_is_sized` answers no. The helper
sets `TS_HDR_SIZED` only for a nonzero extent, so the answer stays the same
(the third review: with the class index off, a header-only instance
relinked behind a field-bearing prototype would otherwise pass the typed
guard of `ts_typed_slow` and read past its allocation).

**What the gate check proves.** It fails on a direct assignment to the
`hdr_spare` or `inline_cap` member outside the helpers (the two direct
`inline_cap` stores, plain allocation and `obj_abandon_layout`, go through
helpers too); it does not see writes through `pin_word`, whole-header or
containing-struct assignments, initializers, compound literals, bulk
operations or aliasing pointers. Those are audited and listed as the
lifecycle writes they are: the allocator's zeroing of runs and cells
(`ts_rt.c` 401, 416), stack functions' `memset` (1639), the emitter's
stack clearing, positional static literals (both emitters, `ts_rt.c`
4321), protect mode's and zap mode's poisoning of dead cells (5406). The
third review found no live-header copy.

## H1: what `size` did, and what replaces it

The header's `size` has 19 readers and writers in `ts_rt.c` and
`ts_rt.h`, plus initializers in both emitters, the runtime's
`TS_TYPEOF_STATIC` literals and the runtime tests (the review's inventory:
`ts_rt.c` 1238, 1256, 1642, 3722-3723, 4321, 5349, 5430, 5538-5539, 10662,
10674, 10685, 12267, 14875, 14892, 14904, 14915; `ts_rt.h` 147, 158, 162,
457; `emit_c.rs` 10151, 18403, 18420; `emit.ts` 223; `emitc.ts` 414, 4652;
`ts_rt_test.c` 597; `ts_sc_test.c` 16). `json_core.c`, the regexp and
unicode adapters and the tsc-ts host touch neither `size` nor
`remembered`.

1. **Heap accounting** (`gc_account_alloc`, `gc_cell_heap_bytes`,
   `gc_cell_die`, protect mode's quarantine, the G0 statistics): the cell's
   capacity: its size class's size for a small cell; for a large cell the
   bytes its run records (the request: large runs only unpoison and zero
   the request, so their slack is never exposed). The run kept the request
   in a `uint32_t` saturated at `UINT32_MAX`, and a UTF-16 string can ask
   for more: as built, the block records the run's slack instead (its
   blocks' bytes past the request, always below one block), so the request
   is exact at any size and the block table keeps 32 bytes per block.
   Protect mode's quarantine budget keeps counting a run's physical
   footprint. Allocation accounts the same capacity in the heap and
   old-generation counters, which drive full collections; the young
   trigger and the statistics keep counting requests, so minor collections
   come exactly when they did. The A/B reports collection counts and
   instructions as well as time.
2. **Is this a sized instance** (`ts_obj_is_sized`): `TS_HDR_SIZED`, set
   with the extent wherever a sized cell is made: `ts_new_sized_impl`'s
   sized path, before any pretenured prototype barrier (not the
   field-less class's plain path), the public `ts_new_sized` (the runtime
   tests use it with no class word), stack instances and stack-check
   copies in both emitters (also with the class index off); cleared only by
   a successful `obj_abandon_layout`. Relinking, `Object.setPrototypeOf` and
   class registration do not change storage and keep it. `cls != 0` is not
   a substitute: field-less classes' plain instances carry a class word.
3. **Is the instance as large as the layout** (`class_reg_for`,
   `class_field_lookup`: `o->h.size >= reg->min_size`; `prop_ic_fill_struct`;
   `obj_abandon_layout`'s area): the extent above, exact as `size` was. (The
   first draft used the class index word or the cell's capacity: stack
   instances have no block, instances made through `ts_new_sized` or with
   the class index off have no word, and a capacity admits a larger
   layout that the exact size rejects, exposing padding as fields.)
4. **The location cache's key** (`receiver_size`): the extent, which
   discriminates exactly as the size did.
5. **A string's in-place capacity** (`ts_string_storage_capacity`): a small
   heap string's class capacity (ASan builds zero only the request; the
   slack is unpoisoned, and the builders write the units they append and
   the terminator explicitly, keeping the reserved trailing code unit), a
   large one's recorded bytes, 0 for a static literal.
6. **Initializers**: positional header initializers lose their last member
   (static string literals in both emitters, `TS_TYPEOF_STATIC`); stack
   instances store `TS_HDR_SIZED` and the extent through one helper
   (`ts_hdr_init_sized(h, sizeof(S))`) instead of a size; stack functions and
   the stack-check test drop their size store (the test sets the flag); the
   runtime test asserting the remembered byte reads bit 0.

## H1: steps and verification

Two commits:

1. The flags byte (bit 0 everywhere `remembered` was), `TS_HDR_SIZED` and
   the extent, with every sized cell's initialization in the runtime, both
   emitters and the frozen templates (minimal fix); stack instances start
   unshaped; `ts_obj_is_sized`, the layout checks and the location cache
   read the extent; the card helpers and their gate check; the checked
   encoding; a large run's exact request; accounting uses capacities. The
   header keeps its `size` (still written, no longer read). Same language
   behavior; collection timing moves (capacity accounting).
2. `size` leaves the header: the 8-byte header and assertion, the positional
   initializers shortened in both emitters, the frozen templates and the
   runtime.

Before every build: delete the cached regexp, unicode and QuickJS objects
(`build/regexp`, `build/quickjs`, and each native build's copies): they are
reused when present, whatever header they were compiled against.

Gates for each commit: unit, parity (text only: the frozen templates
patched, identical output), bundler, selfconf, defaults, GC stress (ASan,
protect), conformance plain, strict and at every allocation under protect
mode; new targeted tests: stack instances with the class index off, the raw
`ts_new_sized` API, two incompatible layouts that share a capacity,
factories, subclasses, relinked instances and `delete` (also absent and
refused deletes, `Object.defineProperty` attribute changes and
`obj_to_dictionary` on old instances, each followed by a field read and a
collection), dynamic properties added to stack instances with property
caches on (emitted stack-check code included), the sized flag surviving
promotion and full collections, both empty-class modes, a module record
with more than 255 fields holding young dictionary values and Symbol keys,
written before and after its promotion and rescanned by minor and full
collections, the encoding's limits, header-only instances (stack, heap,
stack-check) relinked behind a field-bearing prototype and read and written
through a typed field with the class index off, the remembered-slot merge
and its full-scan fallback for plain objects, string growth into recycled small and
large slack under ASan and protect; tsc-ts and the
compiler rebuilt and run under protect mode, protect with a minor every 64
allocations and zap with one every 16 (outputs identical); A/B of both
programs (wall, instructions, collection counts, peak memory); the selfhost
milestone (the frozen typed analyzer's own IR byte-identical).

## H1 as built

Session 352. Commit 1: the flags byte, `TS_HDR_SIZED` and the extent, as
designed above, with `size` still written and never read. Commit 2: `size`
leaves the header (8 bytes, asserted), with its three writers and the
positional initializers of static strings in the runtime, both emitters and
the frozen templates. Where the build departs from the draft:

- **The encoding check** runs at class registration and in `ts_new_sized`
  (`ts_sized_extent_words`, aborting through `ts_sized_extent_abort`), not
  as a static assertion per class struct.
- **A large run's request** is kept as its slack in the block table
  (`gc_block.slack`), not a widened `bytes` field.
- **The young trigger** keeps counting requests, so minor collections come
  when they did; the heap and old-generation counters (full collections)
  count capacities.
- **Stack instances** are initialized by `ts_hdr_init_sized(&h, sizeof(S))`
  in both emitters (the frozen template's minimal fix drops the redundant
  `remembered=0` store); their shape is `0` with property caches on too.

Found on the way, not H1's: the class registry does not keep its
prototypes alive, and its index answered for a cell with its oldest
registration, so a prototype that took a dead registered prototype's cell
(a class evaluated per call registers a fresh prototype each time) found
the dead class's layout: its own fields went to the dictionary and the
collector scanned the wrong ones. A registration now replaces the entry
for its cell (`class_reg_index_put`). And with `TSAOT_CLASS_INDEX=0` a
sized instance relinked behind another class's prototype takes that
class's layout (only the class index word remembers the allocation class):
the relinks fixture reads its own fields as undefined there, as it did
before H1; production keeps the class index.

Tests: `gc/sized_header_layouts` (header-only instances relinked behind a
field-bearing prototype and used through its typed fields and methods,
subclasses, factories, converting, absent and refused deletes, attribute
changes, numeric fields), `gc/sized_header_relinks` (sized instances behind
smaller and larger layouts' prototypes, with the class index),
`gc/sized_header_big_record` (a 300-field class and a 300-binding module
record taking young values, dictionary entries and Symbol keys before and
after promotion), `gc/sized_header_stack_props` (stack instances, also
header-only, taking dynamic properties) and `gc/string_slack_growth`
(builders growing into recycled slack, 8-bit and UTF-16, small and large),
all in the GC stress filter; unit tests for the flag, the extent across
promotion, barriers and collections, exact layouts at one word apart, the
encoding's limits (a child process must abort) and the registry; and
`tests/cell_header_gate.sh` (in the GC stress gate) running the fixtures
with the class index off, property caches off, header-only instances as
unsized cells, whole-cell rescans, stack check, protect and zap modes with
frequent minor collections and a forced full-collection threshold. Each of
four mutations (card writes over a sized instance, shaped stack instances,
flagged header-only instances, the card window over a sized instance's
entries) fails at least one of them.

Measured, outputs identical throughout. Commit 1 against the commit
before it: tsc-ts (twelve pairs) wall 1.000, instructions 1.000, peak
memory 1.004; the TypeScript compiler (eight pairs) wall 0.998,
instructions 0.999, peak 1.000; the same collections (tsc-ts 107 minor and
3 full; the compiler 317 and 316 minor, 3 full), and the heap counted at
tsc-ts's third full collection 0.8% larger (capacities, not requests).
Commit 2 against commit 1: tsc-ts wall 0.989, instructions 0.998, peak
memory 0.947; the compiler wall 1.000, instructions 1.004, peak 0.953.
The old cells live at exit (the statistics build's resident walk) shrink
from 503.5 MB to 463.2 MB in tsc-ts (-8.0%; the walk above predicted
-7.0%) and from 573.6 MB to 539.8 MB in the compiler (-5.9%; predicted
-5.3%). Smaller requests fill the young generation's byte budget later:
tsc-ts runs 99 minor collections instead of 107, the compiler 295 instead
of 316; in the compiler two allocation sites fewer tenure, so more cells
are promoted by minor collections (mark edges +11%), which is where its
0.4% more instructions go (time unchanged).

## H2: sized instances without the property-map fields

A sized instance carries the common object header's property map, `props`,
`cap`, `len` and `prop_index` (24 bytes), for the rare dynamic property
added to it: of the 2.83 M objects tsc-ts holds at exit, 2.82 M are sized
instances and 923 own any property storage (the statistics build's
resident walk).
H2 moves the map of a sized instance into an owned sidecar: one nullable
pointer instead of 24 bytes, 16 bytes saved per instance (tsc-ts: the walk
above put H1 and H2 together at -94.1 MB of live cells, H1 alone measured
-40.4 MB). This is the review's direction: no address-keyed side table, no
extra young-death logging, payload tracing as it is.

### Layout

```c
typedef struct ts_propmap {          /* a named-property map */
  ts_prop* props; uint32_t cap, len;
  uint32_t* prop_index;
} ts_propmap;
typedef struct ts_obj_common {       /* every object kind's prefix, 48 bytes */
  ts_gc_header h; tsv proto;
  uint32_t cls, shape;               /* moved up: common to both layouts */
  union { ts_propmap map; struct { ts_prop* props; uint32_t cap, len; uint32_t* prop_index; }; };
} ts_obj_common;
typedef struct ts_sized_head {       /* a class instance's prefix, 32 bytes */
  ts_gc_header h; tsv proto;
  uint32_t cls, shape;
  ts_propmap* dyn;                   /* its own dynamic properties: NULL until the first */
} ts_sized_head;
```

`h`, `proto`, `cls` and `shape` keep one offset in both prefixes, so
everything that reads them (the property caches' shape guards, the class
index tests, the generated code's typed guards, relinking, integrity) works
on either. A new header flag, `TS_HDR_SIDECAR` (bit 2), says the map lives
behind `dyn`: set on every instance made from a class struct (heap through
`ts_new_sized`, stack, stack-check copies), sized or header-only, and kept
by `delete`'s conversion; `TS_HDR_SIZED` keeps its meaning (an extent above
zero). A header-only instance is now 32 bytes, smaller than an in-place map
needs, so it is a sidecar object too, never a plain one (which would read
its map past the cell). Generated class structs start with
`ts_sized_head header;`; the extent counts words after it; the emitters no
longer store `props`, `cap` and `len` at allocation (cells and stack structs
are zeroed, `dyn` starts NULL).

### Every access to the map

The compiler lists them: with the four fields renamed in a scratch copy,
the runtime fails to compile at 128 places in 39 functions, 13 more under
`TSAOT_RT_STATS`, a few in the unit tests, three emitter templates and the
frozen template. They fall in two classes.

- **Plain objects only** (no sidecar object reaches them; they keep the
  in-place fields): the shaped paths (`ts_obj_slot_ptr`, the inline
  property cache probes, `ts_write_barrier_at`'s slot computation, literal
  layouts: `ts_lit_store`, `new_object_layout_impl`,
  `ts_obj_adopt_layout`), prototype objects (`ts_clone_class_proto`),
  function-constructed instances (`ts_construct`'s slot estimate,
  `ts_construct_end`), typed arrays (`ts_ta_try_length`), the shape
  statistics, and `obj_to_dictionary` past its early return for unshaped
  objects.
- **Any object** (they go through `ts_propmap* m = obj_map(o)` for reads,
  `obj_map_w(o)` for writes, which allocates the sidecar as a payload owned
  by the object): the dictionary accessors (`obj_key_at`, `obj_val_at`,
  `obj_flags_at`), the index (`prop_index_capacity`, `_put`, `_rebuild`,
  `_reserve`, `_lookup`, which take the map), `prop_find`, `props_define`,
  `props_append_f`'s dictionary path, `props_delete_own`,
  `props_release_dead`, enumeration (`ts_prop_own_enum`,
  `count_own_enum_sym_props`, `inspect_own_sym_props`,
  `ts_get_own_property_descriptors`, `propbag_len` and `_prop`,
  `json_emit_prop_map_direct`), the out-of-line property caches
  (`prop_ic_probe_own`, `prop_ic_probe`, `prop_ic_fill`, `prop_add_lookup`,
  `prop_add_fill`, `ts_set_pic`), `obj_abandon_layout`, and the collector
  (`gc_mark_common_props`, the statistics' `g0_count_fate`).

`obj_map(o)` is `&o->map` for a plain object and `o->dyn` (or a shared
empty map) for a sidecar object: one test of the header byte the paths
already load. The shaped hot paths do not take it.

**A gate keeps it that way**: a script copies the runtime, renames the
in-place fields, compiles it (also under `TSAOT_RT_STATS`) and fails when a
function outside the plain-only list touches them; a new direct access in
generic code fails the build check, not a program.

### What changes besides the accessors

- **The collector**: `gc_mark_common_props` marks the sidecar payload, then
  the map's vector and index, then its entries; a sized instance stays
  whole (no card window), a converted sidecar object (below) keeps the card
  window over its dictionary entries.
- **`delete` of a struct field** (`obj_abandon_layout`): the fields and the
  own properties become dictionary entries in the sidecar (allocated if
  NULL), `TS_HDR_SIZED` clears, `TS_HDR_SIDECAR` stays; the struct area is
  dead space (it was in-object slots no dictionary reads). The 255-slot
  limit goes: the area no longer has to fit `inline_cap`.
- **Stack instances** allocate their sidecar with `malloc`, as their
  property vectors are today (`gc_owned_alloc` for an owner outside the
  heap).
- **The class registry and `ts_construct`**: sizes count from
  `sizeof(ts_sized_head)`; a class registered without fields allocates a
  header-only instance, whatever size it was registered with (the frozen
  untyped emitter registers `sizeof(ts_object)`).
- **The frozen emitter's templates** (the minimal fix the frozen-source rule
  allows): `ts_sized_head header;` and no map stores, so the selfhost bench
  keeps compiling and the parity stays byte-identical.

### Slices and verification

1. No behavior change, runtime only: reorder `ts_obj_common`, add
   `ts_propmap` and `obj_map` (always in place), convert the generic
   functions, add the gate. Generated code unchanged (parity trivially), A/B
   neutral.
2. The sidecar: `ts_sized_head`, `TS_HDR_SIDECAR`, `obj_map`'s branch and
   `obj_map_w`, the collector, `obj_abandon_layout`, header-only instances,
   the emitters and the frozen templates, the registry's base size.

Slice 1 as built (Session 352): `ts_propmap`, the reordered prefix (the
field names stay, through an anonymous union, for generated code), the two
accessors, and the 133 accesses rewritten at the positions the compiler
reported (`obj_map_plain` in the plain-only functions, `obj_map`
elsewhere); `tests/propmap_access_gate.sh` (in the unit gate) is the
renamed-copy check, for the plain and the statistics builds. Outputs
identical; tsc-ts wall 0.994 and instructions 1.000, the compiler wall
1.003 and instructions 1.000 (twelve and eight pairs).

Slice 2 as built (Session 352), as designed above, plus what the first
A/B asked for: `obj_map`'s test costs the TypeScript compiler 0.3% more
instructions and 0.8% more cycles where its plain objects go through the
generic paths (10.2 M cached property additions, the out-of-line property
caches, `prop_find`), so the paths that know their object is shaped (a
matched addition record or shape, `prop_find`'s shaped branch, a shaped
append) take `obj_map_plain`, the own-slot probe reads the map once, and
the collector tests the flag once (an instance without a sidecar has
nothing more to mark). New fixture `gc/sized_sidecar_props` (data,
accessor, Symbol and non-enumerable properties on young and old sized and
header-only instances, enumeration, deletes, frozen and sealed instances,
relinks, a 260-field instance) in the GC stress filter and the cell header
gate. Measured against slice 1, outputs identical: tsc-ts (twelve pairs)
wall 0.994, cycles 0.992, instructions 1.002, peak memory 0.943; the
compiler (ten pairs) wall 1.000, cycles 1.001, instructions 1.000, peak
0.988. Old cells live at exit: tsc-ts 463.2 -> 416.9 MB (-10.0%), the
compiler 539.8 -> 530.6 MB (-1.7%). With H1, tsc-ts's live cells went from
503.5 to 416.9 MB (-17.2%; the walk predicted -18.7%) and its peak memory
from 823 to 738 MB (-10.3%); the compiler's peak from 774 to 728 MB (-5.9%).

Gates for each: unit, parity, bundler, selfconf, defaults, GC stress (with
the cell header gate), conformance plain, strict and at every allocation
under protect mode; new targeted tests: dynamic properties (data,
accessors, Symbol keys, non-enumerable, frozen and sealed instances) added
to young and old sized and header-only instances, heap and stack, before
and after promotion, rescanned by minor and full collections; enumeration
(`Object.keys`, `entries`, `for-in`, spread, `Object.assign`,
`JSON.stringify`, `console.log`) of instances with dynamic properties;
`delete` of struct fields and dynamic properties, including instances
whose struct area is under three words and above 255; the property caches
on sidecar objects (own, absent, added); relinked instances with dynamic
properties; tsc-ts and the compiler under protect and zap modes; A/B (wall,
instructions, collections, peak memory); the selfhost milestone.
