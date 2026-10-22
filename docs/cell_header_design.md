# The cell header at 8 bytes (H1), and sized instances without dynamic-property fields (H2)

Session 352. Status: design for H1, revised after a review (Codex,
gpt-6.1-sol at xhigh effort: one blocking, three major and one minor
finding), a second (two blocking, two major) and a third (one blocking,
one major, nothing minor), all answered below; H2 sketched. Runtime (`ts_rt.c`, `ts_rt.h`),
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
through three helpers (mark every card, merge a slot's card, reset) that
leave a sized instance's bytes alone and remember it whole, and a gate
check, like the inline-policy gate, fails on any other assignment to
`hdr_spare` or `inline_cap` in the runtime. `ts_write_barrier_at` and
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
it, or more than 65,535 words: the emitter adds a static assertion per
class struct; the public `ts_new_sized` passes through the same check,
before the existing clamp to `sizeof(ts_object)` (`ts_rt.c` 1827).

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
   bytes its run records (`gc_block.bytes`, the request: large runs only
   unpoison and zero the request, so their slack is never exposed).
   `gc_block.bytes` is a `uint32_t` saturated at `UINT32_MAX` (`ts_rt.c` 310
   and 393), and a UTF-16 string can ask for more: it widens to 64 bits and
   both saturating stores go (the block table grows by a few bytes per 64
   KiB block). Protect mode's quarantine budget keeps
   counting a run's physical footprint.
   Allocation accounts the same capacity. The byte counters drive minor and
   full collections, so collection timing moves slightly: the A/B reports
   collection counts and instructions as well as time.
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
   encoding; `gc_block.bytes` widened; accounting uses capacities. The
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

## H2 (sketch, after H1)

The review's simpler direction comes first: a sized instance keeps `h`,
`proto`, `cls` and `shape` and replaces `props`, `cap`, `len` and
`prop_index` (24 bytes) with one nullable pointer to an owned property
sidecar holding them, allocated as a payload when a property is first
added to an instance: 16 bytes saved per instance, no address-keyed side
table, no extra young-death logging, the existing payload tracing.
(Moving a dictionary's capacity and index into its payload, proposed in
`docs/gc_v2_design.md` §4.5, is a smaller step on the way.) Open: every
generic property path that reads `props` on an object (about 60 sites),
the property caches, `delete`'s in-place conversion to a plain
`ts_object`, integrity flags (they stay in `shape`), and the GC's scan of
an instance with a sidecar.
