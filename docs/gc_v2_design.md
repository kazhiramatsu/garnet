# GC v2 — heap layout and collector redesign

Status: v1, 2026-10-20 (Session 350, after build `x69`). Direction set by Kaz:
the collector needs a fundamental redesign; change its algorithms and data
structures, taking the lessons of the earlier attempts into account.

Relationship to earlier plans: `docs/gc_moving_plan.md` (v1, s316) Phases A
(worklist marking) and B (bump nursery) are in place; its Phase C (direct
pointers through a copying nursery) failed as C1 (s320, analysis in
`docs/runtime_perf_plan.md` §2) and was reverted. Track B of
`docs/v8_parity_roadmap.md` (`docs/pointer_stable_old_gen_design.md`) gave old
cells direct pointers. This document replaces Phase C and Track D of the
roadmap.

## 1. Measurements that motivate the redesign

Compile of `src/compiler` with emit (the benchmark's command), build `x69`,
2026-10-20, interleaved runs:

| | garnet native | Node (V8) |
|---|---|---|
| wall | 4.23 s | 3.22 s |
| instructions retired | 84.2 G, one thread, IPC 4.56 | 95.1 G over all threads, IPC 3.7 (user 5.8 s: JIT and GC helpers; main thread about 50 G by the user/real split) |
| bytes allocated | about 2.5 GB (peak footprint with collections disabled) | 4.35 GB (sum of `--trace-gc-nvp` `allocated`) |
| collections | about 290 minors (4 MB nursery), 3 full | 79 scavenges (new space grows 1 → 64 MB), 2 mark-compacts |
| collector time | collector 6.1%, allocation 3.0%, write barrier 0.7% of samples (about 0.4 s) | main-thread pauses 170 ms (scavenges 156 ms, mark-compact 14 ms: marking is concurrent) |

Cell sizes (`sizeof`, 64-bit): header 32 B; plain object 72 B + 8 B per
in-object slot; array 128 B (four inline elements); function 120 B; string
64 B + characters; Map 144 B; Set 136 B. V8 without pointer compression (Node's
default): one 8 B map word; object 24 B + 8 B per field; function about 64 B;
sequential string 16 B + characters.

With collections disabled (thresholds huge) the compile is slower, not
faster: 4.38 vs 4.23 s and +5% instructions at equal IPC. Every object stays
young, so every access to it goes through the handle table; the addition
cache refuses young prototypes (`prop_add_fill` records only old ones), so the
constructors' property additions run the slow path (+150 samples); and the
nursery's per-object `memset` first-touches 2.6 GB of fresh pages (+81
samples). In this design the collector also converts objects into the fast
representation (direct pointer, cacheable prototype); stopping it leaves
everything in the slow one.

Where the collector's time goes today (profile of `x69`, 3,388 samples):
`gc_free_cell_payload` 49 (the nursery sweep visits every dead cell to free its
handle and its malloc'd buffers), `gc_mark_common_props` 49, `gc_scan_cell`
38, `gc_mark_visit` 26 (marking, mostly the three full collections over
17-209 MB of live data), `gc_alloc` 34 + `memset` 23 + `bzero` 11 (allocation:
an out-of-line call, the trigger checks, a handle, a per-object memset),
`mi_page_free_list_extend` 33 (mimalloc page setup for promoted and
pretenured cells), `ts_gc_collect_young` 17, `gc_sweep_nursery` 11, `mi_free`
10, `ts_write_barrier_ptr` 19. Garnet allocates fewer bytes than V8 but pays
about 2.4 times V8's main-thread collector time, plus an allocation path V8
inlines into its code. The costs are structural:

1. a handle per allocation, freed per dead cell; every young dereference and
   barrier classification reads the handle table;
2. the nursery sweep visits every dead cell (handles, payload `free`);
3. promotion is `malloc` + `memcpy` + handle repoint + slot rewriting;
4. old cells are mimalloc blocks on a linked list (`gc_next`), mark bits live
   in the headers;
5. payloads (property vectors, element buffers, environments, Map/Set tables)
   are malloc'd outside the collector's accounting (TODO "Next slices" (0): a
   loop that drops large arrays grows without bound);
6. 32-byte headers (handle, size, `gc_next`) on every cell.

## 2. Constraints inherited from the earlier attempts

- **No conservative stack scanning** (s321, rejected after Kaz's challenge):
  at `-O2` a tsv local can be dead while a derived raw pointer is live, so a
  conservative scan frees too early. Roots stay precise: shadow frames
  (`ts_frame_hdr`), `ts_gc_root`, static roots, lazy frames with register
  homes (x62).
- **C1's root cause must be impossible by construction, not patched**: with
  direct pointers the collector could not tell a heap pointer from a value
  that merely carried a heap selector (garbage, a non-canonical NaN), and
  moving cells exposed stale references held outside scanned slots
  (amnesty classes (a) argument-load-order staleness and (c)
  root-after-alloc). Every gate passed; the compiler crashed at scale.
- Rules R1-R6 of `docs/runtime_perf_plan.md` §2.5 apply: one behavior change
  per commit; the milestone run (the compiler compiling itself and the
  selfhost bench) is an acceptance gate of every slice that changes the
  value encoding or the heap layout; production-checked preconditions, not
  ASan-only guards; STOP means revert and analyze.
- Escape strategies (stack, arena, `TS_GEN_NONHEAP` cells) keep their
  soundness checks (`--stack-check`, lifetime fixtures, GC stress; memory
  `escape-strategy-soundness`).
- Numbers are canonical when boxed (`ts_num` rewrites a NaN whose top bits
  look boxed), so a number never carries a heap selector.

## 3. The central decision: a non-moving heap with sticky-mark generations

Two families meet the goals:

- **Y1, moving nursery** (V8, HotSpot): a copying (Cheney) young generation,
  direct pointers, every reference rewritten when a cell moves.
- **Y2, non-moving heap** (JavaScriptCore's Riptide, Sticky Immix): cells are
  allocated in size-segregated blocks and never move; a generational
  ("eden") collection marks only young cells, because old cells keep their
  mark bit between collections ("sticky" marks); survivors become old in
  place.

**Y2 is the lead design.** Reasons, against the constraints above:

1. Cells never move, so handles have no purpose and references become direct
   pointers without the stale-reference hazard: a tsv held in a C local across
   a collection stays valid as long as the cell is alive, exactly as a handle
   does today. Amnesty classes (a) and (c) cannot occur.
2. A misdecoded value can only retain memory. The collector rewrites nothing,
   so a garbage word that happens to point at a cell keeps that cell alive
   and changes no value; with the cage check (§4.1) a garbage word that points
   anywhere else is ignored, so the collector cannot fault on it. C1's root
   cause becomes harmless by construction.
3. An eden collection is marking only: no copying, no promotion copy, no
   per-dead-cell work (dead cells are free because their mark bit is clear).
   Promotion is free.
4. It deletes machinery: the handle table, the two reference forms of Track
   B (`ts_same_cell`, slot fixups, `gc_rewrite_promoted`), pinning
   (`pin_depth`, retained chunks, `g_pinned_young`), aging and to-space
   copies, the coroutine/promise move switches, `gc_next`.
5. The write barrier tests header bytes of the owner and the value; identity
   hashes can be derived from addresses (no move ever invalidates them).

The risks of Y2, and how they are tested before the design is committed:

- **Allocation locality.** A copying nursery allocates sequentially in a small
  region that stays in cache (today 4 MB; measured: 16 MB nurseries +0.7%,
  64 MB +2.7% slower). Y2 allocates into the free cells of recycled blocks.
  Mitigation: young allocation prefers the blocks reclaimed by the last
  collection (an "eden pool" that stays hot while survival is low).
  Decision gate (slice G3): cells move into the block heap with handles still
  issued, so the value encoding is unchanged; the compile A/B against the
  moving nursery must be within 1%. If it is not, the slice is reverted and
  the plan continues with Y1 (§6, G3').
- **Fragmentation and RSS.** Size classes and block reuse; measured per slice
  (peak RSS is part of every A/B).
- **No aging.** An eden survivor is old at once; objects that die soon after
  one collection are reclaimed only by a full collection. Measured through
  the full-collection count and the old generation's growth.

## 4. Data structures

### 4.1 The heap cage and the block table
At startup the runtime reserves one contiguous virtual range (default 64 GiB,
`TSAOT_GC_CAGE_GB`; a smaller reservation is tried when the system refuses)
with `PROT_NONE`, and commits pages on demand. Every collector-managed cell
and payload lives inside it. The range is divided into 64 KiB blocks; a
block table (one descriptor per block, indexed by `(addr - base) >> 16`)
records the block's state (free, cell blocks of one size class, payload
blocks, large-object run), its cell size, a live-byte count and its
allocation state. Mark bitmaps live in a parallel region, one bit per 16-byte
granule (512 B per block).

`ts_in_heap(p)` is one subtraction and one compare. Non-heap cells (stack,
arena, static literals; `TS_GEN_NONHEAP`) are outside the cage, so the cage
check also separates them from heap cells.

### 4.2 Blocks, size classes, large objects
Small cells (up to 4 KiB) are allocated in blocks of one size class: 16-byte
steps to 256 B, then about 12.5% steps (the classes come from the G0 size
histogram). Larger cells get a run of pages from a large-object area of the
cage with its own descriptor and mark bit.

### 4.3 Marks and allocation cursors (sticky marks)
Between collections a set mark bit means "live and old"; a clear bit means
"free, or allocated in this cycle". Each size class allocates with a cursor
that only moves forward through a block, skipping cells whose mark bit is
set, so a cell allocated in this cycle is never handed out again before the
next collection. After a collection every cursor restarts at its block's
first cell (lazily, through a per-block epoch): the dead young cells are free
because nobody marked them. A maximal run of clear bits is a bump range, so
the fast path is a bump with a limit, as in the nursery today.

The marker counts live bytes per block; a block with none after a
collection returns to the free-block pool (and, after a while, to the system
with `madvise`). Young allocation prefers the blocks reclaimed most recently.

### 4.4 The cell header
Today: 32 B (`kind`, `mark`, `gen`, `remembered`, `pin_depth`, `inline_cap`,
`hdr_spare`, `handle`, `size`, `gc_next`). Target: 16 B in G5 —

```c
typedef struct ts_gc_header {
  uint8_t kind;
  uint8_t gcstate;      /* YOUNG, OLD, OLD_REMEMBERED (write barrier); age bits if aging returns */
  uint8_t inline_cap;   /* in-object slots of a plain object */
  uint8_t hdr_spare;    /* dirty card range of a remembered object */
  uint32_t size;        /* cell bytes (large cells: the run) */
  uint64_t reserved;    /* identity hash or class data; removed in a later step if unused */
} ts_gc_header;
```

The mark bit moves to the bitmap, the generation into `gcstate`, the handle
and `gc_next` disappear. 8 B is reachable later (size from the size class,
`reserved` gone).

### 4.5 Object layout
`ts_obj_common` today: proto 8, props 8, cap/len 8, prop_index 8,
prop_index_cap 4, shape 4 = 40 B after the header. `cap`, `prop_index` and
`prop_index_cap` are needed only by objects with an external property vector
or a dictionary; they move into a small header at the start of that payload.
Target: header 16 + proto 8 + props 8 + shape/len 8 = 40 B before in-object
slots (72 B today), so a four-slot object shrinks from 104 B to 72 B. Moving
`proto` into the shape (V8's maps) is a separate object-model step.

### 4.6 Payloads in the heap
Property vectors, dictionary entries, property indexes, element buffers,
sparse tables, captured environments, Map/Set buffers, promise waiter lists
and coroutine side arrays move from `malloc` to payload cells: headerless
cells of payload blocks, owned by exactly one cell. Allocation of a payload
never collects (no new safepoints; the bytes count toward the next
collection's trigger, which fixes TODO "Next slices" (0)); growth allocates a
new payload and frees the old one explicitly (as `realloc` does today). The
marker marks an owner's payloads when it scans the owner, so a dead owner's
payloads are reclaimed with it, without a visit. A payload of an old owner is
allocated marked, so an eden collection (which does not scan old cells) never
frees it.

### 4.7 Values and the decoder
After G4 a heap reference is the cell address in the 48-bit payload under the
existing selectors (objects, strings, functions); bit 47 keeps tagging
non-heap cells, or is retired when the cage check covers it. The collector's
decoder accepts a payload as a reference only when it lies in the cage, its
block is allocated and it is the first byte of a cell of that block's size
class (exact for size-class blocks and large runs). The check runs in
production builds (R3). A debug mode (`TSAOT_GC_VERIFY_REFS`) aborts with the
slot's location when a selector-tagged value fails it, to find the source.
False negatives: none (real references are made only by boxing a cell's
first byte). False positives: a non-reference word that equals a cell's first
byte keeps that cell alive; nothing is rewritten.

## 5. Algorithms

- **Allocation.** Inline fast path per size class: bump within the current
  free run, initialize the header word. Slow path: the next free run, the
  next block of the class (preferring the eden pool), a free block, or the
  collection trigger (allocated bytes since the last collection, including
  payload bytes). Zeroing: a free run is zeroed when the cursor enters it
  (one large `memset` per run), not per cell. Pretenured allocations
  (guarded constructions, prototypes) are allocated marked and old.
- **Eden collection.** Mark from the roots (frames, `ts_gc_root` slots,
  static roots, async roots, the Symbol.for registry) and the remembered set;
  the marker stops at marked (old) cells; marking a young cell sets its bit,
  its block's live bytes and `gcstate = OLD`. Ephemerons and the symbol weak
  table are pruned as today. Then the remembered set is cleared and the
  cursors restart. Nothing is swept.
- **Full collection.** Clear the bitmaps, mark everything from the roots,
  prune weak tables, restart the cursors, return empty blocks. Pacing as today
  (`docs/full_gc_pacing_design.md`).
- **Write barrier.** Storing a heap value into a heap cell: remember the
  owner when the owner is old (`gcstate == OLD`) and the value is young
  (`gcstate == YOUNG`); the remembered set keeps today's owner list with
  dirty ranges for objects, arrays and Maps. The handle-table loads of today's
  barrier become header-byte loads.
- **Parallel marking** (G7). Collections (full and eden: G0 found the minor
  marking the largest remaining cost) mark with several threads over
  work-stealing mark stacks; mark bits are set with an atomic OR; per-thread
  buffers replace the global weak, non-heap and statistics lists. Concurrent
  marking (V8's) needs a marking barrier on every store and is not planned.
- **Roots, non-heap cells, weak tables, coroutines**: contracts unchanged.
  Coroutine frames are cells like any other; without moving, the resume pin
  disappears.

## 6. Slices

Each slice is one commit (or a few behavior-invariant prep commits plus one
behavior change), passes the full gate set, and is A/B'd on the compile.
"Milestone" means the compile of `src/compiler` with output identical to the
previous build, plus the selfhost benchmark when the slice changes the value
encoding or the heap layout.

- **G0 — measurement (statistics build only, no behavior change).** Counters
  for the questions this design leaves open: the cell-size histogram per kind
  (size classes); young survival per kind and bytes; payloads per kind (count
  and bytes at a dying or promoted cell, by payload type); the time split of
  minor and full collections (marking, weak tables, sweep, rewrite); handle
  table peak; the remembered set's owners per minor; the old generation at
  the end of the run by kind and size (fragmentation estimate). Results go to
  §9.
- **G1 — quick wins on the current collector.** (a) Prototypes materialized by
  `fn_materialize_prototype` are pretenured: the addition cache stops
  depending on the collector's state. (b) Payload growth counts toward a
  payload budget (sixteen nurseries) that triggers a minor collection
  (TODO (0): `sparse_stores` without sparse elements now finishes at 137 MB
  instead of being killed at 16.6 GB). (c) Tried and dropped: zeroing a whole
  nursery chunk when it is taken, instead of each cell on allocation, was
  neutral to 1% slower on the compile (the 256 KiB written ahead of use is
  out of L1 by the time the cells are bumped) and doubled the GC stress
  gate (a minor collection per allocation zeroes a chunk per allocation).
  (d) Aging off (`TSAOT_GC_AGE_THRESHOLD=1`): 4.365 vs 4.400 s median, five
  of eight pairs faster, +10 MB peak: neutral; aging goes with G3.
- **G2 — the cage, the block heap and payloads in it.** Cage, block table,
  bitmaps, size-class blocks with cursor allocation, large runs; every
  payload of §4.6 moves into payload cells; the nursery sweep stops freeing
  payloads (it still frees handles). Cells themselves stay where they are.
  Detection of a missed payload edge: the GC stress gate with zapping of
  freed payload cells.
- **G3 — cells in the block heap, non-moving, sticky marks; handles kept
  (decision gate).** Young and old cells are allocated in the block heap;
  minor collections become eden collections; promotion is in place; the
  nursery, aging, to-space and the old list go. Handles are still issued (the
  value encoding is unchanged): a log of the handles issued in the cycle lets
  an eden collection free the dead cells' handles without visiting the
  cells. Gate: compile A/B within 1% of the moving nursery (G2) and RSS within
  10%. Pass: continue with G4. Fail: revert, and continue with G3' instead.
- **G4 — direct pointers.** Handles go: boxing a heap cell yields its address,
  `ts_ptr` masks; the decoder of §4.7; `ts_same_cell` becomes equality, the
  slot fixups, promoted-cell rewriting and pinning are deleted; Map/Set and
  WeakMap identity hashes derive from addresses. Milestone required.
- **G5 — smaller cells.** The 16-byte header of §4.4 and the object layout of
  §4.5 (`cap` / `prop_index` into the payload header).
- **G6 — inline allocation.** The emitter inlines the bump fast path for
  objects, arrays, closures and records of known size class.
- **G7 — parallel marking** (full and eden collections).
- **G8 — data-driven follow-ups**: aging (an age byte in `gcstate`), block
  defragmentation in full collections (needs moving again: only if RSS
  demands it), `proto` in the shape, smaller strings and closures.
- **G3' — fallback (only if G3 fails its gate).** Keep the copying nursery;
  remove handles through Cheney evacuation with reference rewriting. This
  needs the stale-reference audit C1 skipped: from-space pages protected
  (`mprotect`) after every minor in stress mode, the GC stress gate with a
  minor at every allocation, and the milestone.

Expected effect, to be refined by G0: the collector-related share (about 10%
of a compile) toward V8's (about 5%): G2 removes the payload frees and most
mimalloc work (1-2%); G3/G4 remove the per-dead-cell sweep, promotion copying,
handle issue and dereference (2-4%); G5 shrinks allocation by about a third
(fewer collections, better density); G6 removes the out-of-line allocation
call (1-2%); G7 cuts full-collection marking (about 3%) by the thread count.
Together about 6-10% of a compile. The rest of the gap to V8 is the
generated code's instruction count (§1), outside this document.

## 6.1 G2 in detail: the payload heap

G2 is the first user of the block heap, so its allocator is the one G3 will
extend to cells. Inventory of the payloads (`gc_free_cell_payload` and the
44 assignment sites of `ts_rt.c`): property value vectors and dictionary
entry vectors (`props_append_f`, `obj_to_dictionary`, `vals_alloc_small` /
`props_alloc_small` and their recycle lists, the prototype clone of a
template), property indexes (`prop_index_rebuild`, calloc'd), element buffers
(`array_init_storage`, `array_ensure_cap`, the rebuilt buffers of splice and
friends, `array_densify`), sparse tables (`sparse_alloc`), closure
environments (`env_alloc` / `env_free` and their pool), Map and Set buffers
(`map_grow`, `set_grow`, the side index, the iteration order arrays),
promise waiter lists, coroutine side arrays and async-generator requests,
`Uint16Array` storage. Strings have none (string builders grow by allocating
a new cell).

Allocator (`gc_payload_*`):

- The cage and 64 KiB blocks of §4.1; the 39 size classes of G0 (16-byte steps
  to 256 B, 12.5% steps to 4 KiB). A payload above 4 KiB is a large payload:
  malloc'd with a small header (mark, size, list links) on a list.
- `gc_payload_alloc(bytes, owner)`: the class's cursor bumps over cells whose
  mark bit is clear; a cell behind the cursor is never handed out again in
  the same cycle. The cell is allocated marked when its owner is old (an
  eden pass does not scan old owners), unmarked otherwise. `_calloc` zeroes
  (property indexes rely on it).
- `gc_payload_free(p)`: clears the mark (the cell is reusable after the next
  collection) or unlinks and frees a large payload; `gc_payload_realloc` is
  allocate, copy, free, as `realloc` is today.
- Marking: whenever the collector scans a cell, it marks the cell's payloads
  (a bit in the cage, the header mark of a large payload). A minor
  collection therefore marks the payloads of every young survivor, of every
  remembered old cell and of every non-heap cell it scans; old owners'
  payloads keep their marks. After a minor collection every unmarked
  payload is free: those of dead young owners and those freed explicitly.
  A full collection clears every payload mark first. The cursors restart
  through a block epoch.
- Transitional cost while aging exists: the payloads of a cell kept young
  under aging are marked by the collection that scanned it; if the cell then
  dies young, they stay allocated until the next full collection (G0: about
  14 MB of payloads were aged per compile). G3 removes aging.
- A payload allocated during a collection (the weak-table pruning compacts
  a WeakMap and rebuilds its index after the map was scanned) is allocated
  marked: its owner is live, and an unmarked cell would be free once the
  collection ends.
- Owners outside the heap (stack and arena cells, `TS_GEN_NONHEAP`) keep
  malloc'd payloads: the collector sees such a cell only when a frame slot
  references it, and a cell that holds no heap reference need not be
  visible at all, so its payload could not be marked. `gc_payload_free`
  therefore tells the two kinds of buffer apart by the cage check.
- Payload bytes feed the G1 (b) budget; under `TSAOT_GC_ZAP` freed and
  reclaimed payload cells are filled with 0xDD, so a payload reached through
  a stale or unmarked pointer reads garbage under the GC stress gate.

Sub-slices, each one payload family end to end (allocation, growth, release,
marking), each with the full gates, the GC stress gate under zapping and a
compile A/B:

- **G2a** the payload heap itself and closure environments (943k of the
  1.36M dying young payloads; the environment pool goes); done: neutral (instructions +0.02%, cycles +0.16%);
- **G2b** element buffers and sparse tables; done: neutral (cycles -0.27%);
- **G2c** property vectors, dictionary vectors and property indexes; done:
  neutral (cycles +0.25%);
- **G2d** Map and Set buffers; done: neutral;
- **G2e** promise, coroutine and `Uint16Array` buffers; `gc_free_cell_payload`
  then frees nothing but handles.

## 6.2 G3 in detail: cells in the block heap, handles kept

G3 changes where cells live and how young cells die, but not how they are
referenced, so the value encoding, the write barrier and Track B's two
reference forms are untouched; the A/B against G2 then measures the
non-moving allocation (its locality) and the removal of copying alone.

- Cell blocks: the payload allocator of G2 with a second block state (cell
  blocks), the same size classes and cursors; cells above the small maximum
  take large runs. The nursery chunks, the to-space, aging, the unpooled
  young list and the old list (`gc_next`) go; `gc_alloc` and
  `gc_alloc_pretenured` allocate from the cell blocks (a pretenured cell is
  allocated marked and old).
- Marking keeps the header mark byte during a collection (the weak tables
  and the non-heap visited list read it); the block bitmap holds the
  persistent "old" marks between collections, which is what the cursors
  read.
- Handles are the cell index of this transitional state: every heap cell
  has one. A log of the handles issued since the last eden collection
  replaces the nursery sweep: after marking, a logged handle whose cell is
  marked is promoted in place (bitmap bit, `gen = OLD`, the handle entry's
  old bit, the mark cleared); one whose cell is not marked is freed. A full
  collection walks the whole handle table the same way after clearing the
  bitmaps. Dead cells are not otherwise visited; their payloads are
  unmarked (G2).
- Track B's rewriting of promoted cells' slots and of the recorded stable
  slots stays as it is (promoted cells come from the log instead of the
  sweep).
- Gate (§6): within 1% of G2 on the compile, RSS within 10%; plus the GC
  microbenchmarks (`scripts/bench_gc.sh`) for the cases a copying nursery
  favors (short-lived binary trees, survivors).

## 6.3 G3 result: segregated fits fail the gate; Immix lines next

G3 as specified (§6.2: cells in blocks of their size class, cursors over runs
of unmarked cells, sticky marks, a handle log instead of the sweep) was built
and measured against G2d (both relinked onto `native_s350nk`): wall +2.95%
(eight of eight pairs slower), instructions -0.11%, cycles +3.3% (+3.6% after
a word-at-a-time run search). Fewer instructions and more cycles: the cost is
memory, not work. The statistics build puts its collections at about 290 ms
against about 320 ms for the moving nursery (minor marking 93-97 ms, the
handle-log walk 103 ms, full marking 39-48 ms), so the collector got faster;
the loss is on the mutator side. The profile shows the allocation slow path
(`gc_space_refill`, 91-109 samples: walking class block lists across blocks
filled by old cells, and short runs between scattered survivors) and the
allocation itself (`gc_alloc` +31, `memset` +18), with the generated code
also slower: size segregation scatters objects allocated together (a node,
its arrays, its strings) over different blocks, and young cells land in holes
spread over the whole heap instead of one reused 4 MB region.

Two unit tests failed under GC stress for an unrelated reason that any
promotion-timing change exposes: they take a "handle-form probe" after an
allocation that, without aging, already promoted the cell (so the probe is a
pointer and never reads NULL), and one compares two references to a cell by
bits (`ts_same_cell` is the rule). Both need the probe taken at allocation and
the identity compare.

Decision: the gate failed for this allocator, not for non-moving collection.
The non-moving design that keeps allocation sequential is Immix's mark-region
(also the basis of Sticky Immix, §3): blocks of 128-byte lines, objects of
any size bumped through runs of free lines, a medium object that does not fit
the current run going to an overflow block, marking setting the lines an
object covers, and free lines reused after a collection. Survivors stay in
place; consecutive allocations stay adjacent whatever their sizes. **G3b**
builds the cell space that way (payloads keep their size classes), with the
same gate (within 1% of G2d). If G3b also fails, the plan continues with Y1
(G3').

## 6.4 G3b / G3c result: non-moving allocation loses about 2.7%

- **G3b** (Immix-style cell space: 128-byte lines, mixed-size bump allocation
  through runs of free lines, overflow blocks for medium cells, the blocks
  used in a cycle reused first): wall +3.15% against G2d (the quiet pairs
  +3.5-4%), instructions -0.65%, cycles +5%. Sequential allocation alone did
  not recover the loss.
- **G3c** (G3b, with cells allocated old, the pretenured constructions,
  bumped through fresh blocks of their own): ten ABBA pairs, wall +2.7%,
  user +2.3%, cycles +2.6% (nine of ten pairs slower), instructions -0.8%,
  peak memory +12% (939 vs 838 MB). Interleaving the long-lived pretenured
  data with young cells was part of the loss (G3b to G3c), but most of it
  remains.

Reading: every non-moving variant executes fewer instructions than the
moving nursery and loses on memory. The nursery's advantage on this
workload is not only its hot, reused 4 MB region but its promotion: the
survivors (12% of the young cells, 227 MB per compile) are copied into old
space densely, while a non-moving heap leaves them where they were
allocated, interleaved with the holes young death leaves (and fills again).
The gate (within 1% of G2d) fails for all three; per §6 the plan continues
with Y1 (G3'): keep the copying nursery and remove the handles through
evacuation with reference rewriting, under the stale-reference protocol of
§6 (from-space protection in stress mode, a minor collection at every
allocation, the milestone). The three runtimes are kept in the scratchpad
(not committed).

## 6.5 Y1 plan: a copying nursery without handles, in steps

Kaz chose Y1 after §6.4. References become direct pointers everywhere (object
fields, frame slots, registers); there is no indirection on access. When the
nursery moves a cell, the collector rewrites every reference to it: the
fields of copied cells (scanned as they are copied), the remembered old
cells' fields, and the root slots (shadow-frame slots and `ts_gc_root`
slots: the collector is given the slot's address, so it can rewrite the
slot; the program reads the slot's direct pointer). Generated code keeps a
reference that lives across a call that can collect in a frame slot and
reloads it after the call (the protocol that already exists for the
pointer-form rewriting of Track B); between such calls it uses the pointer
in a register. The copied cell's old header holds the forwarding address.
V8 works the same way: its JIT code uses direct pointers rewritten through
stack maps; only its C++ runtime uses indirect handles, as garnet's runtime
uses `ts_gc_root`. The hazard is the one that sank C1: a reference held
where the collector does not look (an unregistered C local) goes stale when
its cell moves. Old cells never move in Y1, so only references to young
cells are rewritten.

Track B already rewrites references to the cells a minor collection
promotes (recorded stable slots, promoted cells rescanned). The steps
below reuse that machinery and move the encoding one kind at a time:

1. **Protect mode** (`TSAOT_GC_PROTECT=1`, a debug knob): nursery chunks
   come from `mmap`; after a collection the evacuated chunks are made
   inaccessible (`mprotect`, a bounded quarantine before reuse), so a stale
   access faults at its site. First run on the current design (raw `ts_object*`
   pointers held across an allocation), then for every later step under the
   GC stress gate (a minor collection at every allocation).
2. **Aging off by default** (measured neutral, G1 (d)): every survivor is
   promoted, so every moved cell is rewritten once, and the to-space path,
   scan credits and the promotion barrier go.
3. **Nursery chunks from the cage** (a dedicated range): "young" becomes an
   address test, for the barrier and the collector's edges.
4. **Direct pointers, one kind at a time** (strings first, then arrays,
   functions, objects, the rest): boxing a young cell of a converted kind
   yields its address; evacuation leaves a forwarding address and the
   rewriting covers pointer-form edges to young cells; identity hashes move
   into the header's handle field (assigned lazily); caches keyed by young
   identities are audited per kind. Each kind: protect mode under GC
   stress, the milestone (the compiler compiles itself with outputs
   unchanged, selfhost), A/B.
5. **Handles removed, Cheney evacuation**: no handle table, no handle
   branch in `ts_ptr`, a minor collection that copies survivors while it
   traces and never visits the dead.

Step 1 result. Under `TSAOT_GC_PROTECT=1` with a minor collection every
seven allocations the conformance suite found one stale reference, in
`gc/lazy_homes_reload`: `ts_set_pic` filled its inline cache from the
receiver pointer it held across an own setter, and the setter had
collected and moved the young receiver (a fault in `prop_ic_fill`; in the
default mode the released chunk is still mapped, so the cache could be
filled from whatever the chunk held by then). `ts_set_named_prop` now answers `PREF_NONE` after
running a setter, so no cache is filled from the call. With the fix the
suite passes under protect mode, and the compiler compiles tsc under
protect mode, with and without zapping. The GC stress gate runs the
focused conformance and the runtime unit tests under protect mode
(`TSAOT_GC_STRESS_PROTECT=0` skips the step).

Step 1b. The collector read four runtime roots as values: the `Symbol.for`
registry (keys and symbols), the microtask queue, the pending and active
I/O tasks (promise and abort signal) and the abort timers (signal). A value
read cannot be rewritten, so once cells move without handles these roots
would keep the old address. They are now visited as slots, like the static
roots and frame slots: a reference to a promoted cell takes the pointer
form. A unit test checks the registry slots after a full collection (it
fails on the previous runtime). The new call sites changed clang's inlining
of `gc_visit_slot` in the scan of cells (it became a call there): +1.1%
instructions on the compiler, found by the instruction count of the A/B
(the wall clock was within noise). `gc_visit_slot` is now always inlined;
with that, the slice is neutral. Still read as values, for step 4: the
values of weak maps (the ephemeron pass marks them, and the pruning that
follows compacts the entry arrays, so a slot recorded for rewriting would
move), symbol property keys (a symbol id; the id table must be rewritten
when a symbol moves), and coroutine frames (scanned conservatively: every
word that looks like a reference is marked; step 4 needs a precise map,
the emitter grouping the frame's `tsv` locals and recording their count,
or the referenced cells pinned).

Step 2 result. Aging is off by default (`TSAOT_GC_AGE_THRESHOLD=1`, every
survivor promotes at its first minor collection; `=2` restores the
adaptive policy, which the aging gates now select explicitly). Against
step 1b, eight ABBA pairs: wall -1.0%, instructions -1.1% (eight of eight),
cycles -1.1%, peak memory +0.3%. The to-space path, the scan credits and
the promotion barrier stay behind the knob until step 5 rewrites the minor
collection.

Found while reading the coroutine scan: the conservative scan also reads
the frame's `long long` (integer-specialized) locals, and an integer whose
bits look like an old-cell reference (top 16 bits 0xFFF8 to 0xFFFA: the
integers in [-2^51, -2^51 + 3 * 2^48)) is dereferenced by a full
collection: `-2251799813685248 + 4096` held across an `await` crashes the
program under frequent full collections (`TSAOT_GC_FULL_THRESHOLD_BYTES=65536`).
The precise frame map of step 4 removes the conservative scan, so it moves
ahead as its own slice (step 2b).

Step 2b plan: precise coroutine frames.

- Emitter: a coroutine's frame struct lists its `tsv` locals first, then
  its integer and double locals, and the entry allocates the frame with
  `ts_coro_alloc_vn(sizeof(frame), resume, N)`, N the number of `tsv`
  locals. `TSAOT_CORO_PRECISE=0` keeps the previous layout and allocator
  (the parity oracle's emission).
- Runtime: `ts_coro.nvals` replaces the unused `slots[16]` / `nslots`
  (the header shrinks from 896 to 768 bytes). A frame from `ts_coro_alloc_v` has -1 and is
  scanned conservatively as before (the frozen analyzer's output in the
  selfconf gate); a frame from `ts_coro_alloc_vn` has N, and the collector
  visits exactly the N words after the header, as slots (`gc_visit_slot`:
  a reference to a promoted cell is rewritten to the pointer form, as in
  frame slots).
- Fixture `gc/coro_int_locals`: an async function, a generator and an
  async generator hold integers with reference-like bits across their
  suspension points while enough cells are promoted to run full
  collections (seven in the default configuration); also in the GC stress
  gate's focused set (a minor collection at every allocation, protect
  mode). With the previous frames it crashes in the default configuration.

Step 2b result: as planned. The compiler has thirteen coroutines (its
iterator generators); their frames take the map and the compiled compiler
is otherwise unchanged. The frozen analyzer's output keeps the
conservative scan and passes the fixture (its untyped locals are boxed).
A/B against step 2: neutral (wall 0.999, instructions 0.9997, cycles
1.0004).

Step 3 result. Nursery chunks come from one reserved range (4 GiB of
address space, `PROT_NONE` until a chunk is first handed out; 64 MiB at
least), and `gc_in_nursery(p)` is the address test
`p - g_nursery_lo < g_nursery_span`. Released chunks are reused as before;
an exhausted range falls back to the unpooled path. Protect mode
quarantines chunks inside the range. The nursery sweep and the pinned
sweep check that every chunk and pinned cell is inside the range (abort
otherwise). Nothing uses the test on a hot path yet. A/B against step 2b:
wall 0.988 (eight of eight pairs; three noisy pairs, the quiet ones about
-0.7%), cycles 0.989, instructions 0.9998: the chunks of one contiguous
range instead of `posix_memalign` blocks.

## 6.6 Step 4 design: direct references to young cells

A young cell of a *direct* kind is referenced by its address, the pointer
form an old cell already has (bit 0 clear, bit 47 clear), and has no handle
(`h->handle == 0`). For the pointer form, young and old are told apart by
`gc_in_nursery(p)` (step 3), without a load from the cell. Unpooled young
cells (the kinds outside the nursery and cells over 4 KiB) keep their
handles: they never move, and the existing rewriting gives their references
the pointer form when they are promoted in place.

Allocation and boxing. `gc_alloc` gives no handle to a nursery cell of a
direct kind; `ts_heap_ref_fast` boxes a young cell without a handle by
address.

Minor collection (and the young part of a full collection):

1. Marking. `gc_mark_visit` on a pointer-form value: in the nursery, a young
   cell, marked like a handle's target; elsewhere, old (skipped by a minor
   collection without a load, as now). The full collection's validation of
   the pointer form (`gen == OLD`) accepts nursery cells. `gc_visit_slot`
   records a stable slot holding a reference into the nursery for rewriting
   (the fixup list, as for a young handle). `ts_heap_ptr` decodes a nursery
   address as a young cell.
2. Evacuation. `gc_move_young_to_old` leaves a forwarding address in the
   moved-from header: `gen = TS_GEN_FORWARDED`, `gc_next` = the copy (for
   every moved cell; zapping writes the two fields after the poison).
3. Rewriting. `gc_rewrite_promoted` (the promoted copies' slots) and
   `gc_fixup_apply` (the recorded slots) replace a reference into the
   nursery whose target is forwarded by the copy's address. A pinned young
   cell does not move; references to it stay valid.
4. Weak containers. Their entries are read as values by the ephemeron pass
   and their entry arrays are compacted by the prune, so their slots are not
   recorded; after the evacuation a pass over the weak work list (following
   the forwarding of a weak map that moved) rewrites forwarded keys and
   values.
5. Chunk release after the rewriting: the sweeps collect the evacuated
   chunks on a list released (and protected, in protect mode) after steps 3
   and 4, so forwarding headers stay readable while they are needed.
6. Coroutine frames without a map (`ts_coro_alloc_v`, the frozen analyzer's
   output) are scanned conservatively: a word holding a nursery address that
   starts a cell (validated by walking the chunk's cells) pins that cell for
   the collection (`pin_depth`, released after the sweep); other words are
   ignored. A frame with a map is visited as slots.

Barrier. A value is young when it is a handle without the OLD bit or a
pointer into the nursery; an owner is old when it is a handle with the OLD
bit or a pointer that is neither stack-tagged nor in the nursery. The
nursery bounds become visible to generated code (`g_ts_nursery_lo`,
`g_ts_nursery_span`), and generated code must be recompiled (the barrier and
boxing are inline in `ts_rt.h`): a step-4 A/B rebuilds the compiler.

Identity. All references to a direct cell carry the same bits, so identity
compares as before. Kinds hashed by identity (`sv0_hash`, the class
registry) need an identity hash that survives the move: `h->handle` holds an
even identity id assigned at the first hash (odd = a handle, 0 = none), and
boxing tests bit 0. Strings are hashed by content and need none.

The hazard: C code in the runtime holding an unrooted reference to a young
cell across an allocation. With handles such a copy stays valid; a direct
reference goes stale when the cell moves. Rooted locals are rewritten (the
collector is given their addresses); raw cell pointers are already re-read
after allocations (cells move today). Detection: protect mode under GC
stress (a minor collection at every allocation, released chunks
inaccessible) on the conformance suite, the unit tests and the compiler;
each finding is fixed by rooting the value or re-reading it from a rooted
container.

Slices: 4a the machinery with no direct kind (`TSAOT_GC_DIRECT` selects
kinds, default none; the barrier and boxing changes are live but find no
nursery reference); 4b strings direct under the knob, then by default after
protect-mode stress, the compiler under protect mode and an A/B; 4c and on,
the other kinds (identity hashes and the cache audit first).

### 6.6.1 What 4a found, and the measurement

The 4a machinery was written (not committed; kept in the scratchpad) and
run with strings direct (`TSAOT_GC_DIRECT=strings`):

- The conformance suite passes in the default configuration. Under protect
  mode with a minor collection every seven allocations, two tests failed,
  both stale direct references: the plain finally kept its pending return
  value in a C local (an emitter bug that also freed values under handles:
  fixed and committed on its own, `gc/finally_pending_value`), and
  `ts_str_replace` passed a rooted local to `ts_add` beside an allocating
  argument (`out = ts_add(out, ts_string_slice_view(...))`: C may read
  `out` before the allocation collects). These are the two C1 classes
  (argument-load order, a value held where the collector does not look).
- `scripts/gc_hazard_check.py` (clang's JSON AST; the call graph gives the
  functions that may collect) reports, in the runtime, 66 calls that pass a
  heap value beside an argument that may collect, and 181 reads of an
  unrooted `tsv` or cell-pointer local after a call that may collect (177
  after the Math fixes). Not
  yet covered: generated C's temporaries and the `tsv*` argument arrays a
  builtin reads after it allocates.
- The compiler compiles itself with strings direct, its output identical,
  also under protect mode (default thresholds).
- Cost and gain on the compiler, eight ABBA pairs each: strings direct
  against the same binary without: instructions -0.38% (eight of eight),
  cycles -0.13%, wall -0.12%; the machinery itself (the barrier's nursery
  test, the boxing and collector paths) against the build without it:
  instructions +0.90%, cycles +0.68%, wall +0.71%. The machinery costs more
  than strings direct gain.

So Y1's remaining gain is the other kinds (objects, arrays and functions
have identity hashes and many more young allocations) and step 5 (no
handle table), against a barrier that tests the nursery for every
pointer-form value (two loads; a fixed nursery address would make it a
shift and a compare) and a runtime refactor that the hazard checker must
gate before any kind is direct by default.

The upper bound (every bump kind but symbols and accessors direct, with
identity ids in the handle field and prototypes allocated old) could not be
measured: the compiler stops at once. A barrier verifier (every old cell
checked for an unremembered young reference before each minor collection)
found the first cause, a closure's environment copied from the caller's C
array after the allocation that collected (`ts_make_fn_impl`); rooting it
moved the failure to a stale value in generated code (argument arrays,
temporaries, frame-slot stores without a barrier), the same work as the
production refactor. Allocation counts of one compile (statistics build):
16.0M cells, every one with a handle (2.2M of them pretenured, which never
move); 5.6M objects, 4.5M arrays, 4.5M strings, 0.96M functions, 0.31M Maps
and Sets; 12.2M handle frees. Scaling the strings result by allocations,
every kind direct would save about 1.3% of the instructions and 0.5% of the
cycles, about the machinery's cost; what step 5 would add (no handle
allocation or release at all, no handle branch in `ts_ptr`) cannot be
measured before the refactor.

Decision (Kaz, 2026-10-21): Y1 is paused; the handle encoding stays. What
remains from it: protect mode, aging off, precise coroutine frames, the
reserved nursery range, the hazard checker, and the step 4a machinery in
the scratchpad of that session (not in the tree). Reopen only with a
measurement that shows more than the machinery's cost.

## 6.7 tsc-ts measurements (Session 351): the nursery and the handles

tsc-ts (`docs/tsc_ts_native_design.md`, a modern, closed program: most of
its objects live to the end) after the closed receivers work
(`docs/closed_receivers_design.md`): 2.17 s emitting the TypeScript 6.0.3
compiler project, 41.5 G instructions at IPC 4.45; scriptc runs the same
source in 1.03 s, 18.4 G instructions at IPC 4.08 (one thread; 0.48 s on
its threads). The gap is instructions, not IPC: scriptc's `getName` is
about 15-20 instructions a call (a null test, an i32 kind into a jump
table, the class id read through the vtable, the field load), garnet's
40-50 (the handle branch of `ts_ptr` per dereference, NaN-box tests, the
kind as a double into the switch, `g_class_relinked` and a guard the
`instanceof` just proved). Two measurement builds (scratch, not committed;
outputs identical), six interleaved rounds:

| build | tsc-ts wall | instructions | TypeScript compiler wall |
|---|---|---|---|
| current | 1 | 41.5 G | 1 |
| every cell allocated old (no nursery; references all pointer form) | 0.943 | 38.1 G | 1.079, peak memory +55% |
| the same, and `ts_ptr` without the handle branch | 0.869 | 35.6 G | 0.978 (0.906 against the row above) |

The nursery costs tsc-ts 5.7% (copying, promotion, handles, barriers for
cells that survive anyway) and pays the TypeScript compiler 7.9% (it makes
much short-lived garbage); the handle branch costs tsc-ts another 7.5% (a
load the C compiler cannot hoist across calls, and code).

Both halves of Y2 measured on both programs (six interleaved rounds each,
outputs identical):

| | non-moving young cells, handles kept (`TSAOT_GC_NURSERY=0`) | the handle branch gone (every cell old, against every cell old) |
|---|---|---|
| TypeScript compiler | wall 1.037 (+0.8% instructions) | wall 0.906 (-4.8% instructions, -9.3% cycles) |
| tsc-ts | wall 1.040 | wall 0.920 (35.6 G against 38.1 G instructions) |

G3 (§6.3) measured the left column only: the gate kept the handles, so it
saw the non-moving heap's cost without its gain. Added, the two columns
estimate Y2 with direct references at about 6% faster on the TypeScript
compiler and 4% on tsc-ts, and Y2 removes C1's hazard class by
construction (nothing moves: a reference held in an unscanned C local can
only outlive its cell, which the roots already prevent). spinel
(`matz/spinel`, `lib/sp_gc.h`, `lib/sp_slab.c`) is a working example of the
same design: precise roots in per-function frames on its own shadow stack,
16 KB chunks per size class with side bitmaps (two young epochs, old, mark,
finalize, pin), allocation that claims a run of free bits and bumps through
it, a sweep that computes the dead set from the bitmaps alone, a minor
collection that never frees old cells, and an owner-side write barrier on
the header's old and dirty bits.

This is the measurement §6.6.1 asked for before reopening direct
references: the handles cost both programs far more than the machinery
(about 0.7%), and Y2 with direct references, unlike every cell old (which
loses the compiler its nursery) or the handles kept (G3), is estimated to
gain on both. Allocation-site pretenuring stays an option on top (tsc-ts
loses 5.7% to copying cells that survive). Decision pending (Kaz).

## 6.8 Y2-D plan (Session 351, Kaz: go): the non-moving heap with direct references

§6.7 reopens Y2 as one change: the gain is in the references, so the
non-moving heap is gated together with them, never alone. Slices:

- **D1 — cells in the block heap, handles kept.** G3 as built (§6.2, §6.3:
  segregated size classes, spinel's model) re-applied to the current
  runtime: cells allocated in cell blocks of the payload allocator's size
  classes, sticky marks in the block bitmaps, promotion in place, the
  nursery, to-space, aging, the unpooled young list and `gc_next` gone, a
  handle log instead of the nursery sweep. Behavior-invariant; its own
  commit, measured (expected about +3%, G3's result) but not pushed alone.
- **D2 — direct references.** G4 of §6: every heap cell boxed by address;
  `ts_ptr` masks; `ts_same_cell` is equality; the handle table, the log,
  slot fixups, promoted-cell rewriting and pinning go; identity hashes from
  addresses; the write barrier reads header bytes (the owner old, the value
  young) instead of handle entries. Gated with D1 as one A/B against the
  current build on both programs (estimate: about 6% and 4% faster),
  plus the milestone (the compiler compiling itself, the selfhost bench),
  the GC stress gate with zapping, and protect mode.
- **D3 — 16-byte header** (§4.4) and the layout of §4.5.
- **D4 — inline allocation** (G6) and the runtime's temporary `malloc`s
  (argument and environment arrays) into stack buffers or a scratch arena.

Locality (G3's loss) is the risk D2 has to outrun; spinel's allocator
(runs of free bits, bumped through) is what D1 already does, and its
remaining ideas (two young epochs instead of one bitmap pass, chunk
ownership) are D1 follow-ups if the A/B asks for them.

### 6.8.1 D1 and D2 as built

**D1** as planned: cells are allocated in the cell blocks of the payload
allocator's size classes (runs of free bits, bumped through), a set mark bit
means old, an eden collection promotes the marked cells of the cycle in
place and a full one sweeps; the nursery, the to-space, aging, the unpooled
young list and `gc_next` are out of the collectors. Aging needed a copying
nursery, so the two aging gates (`gc_aging_promotion_gate.sh`,
`gc_adaptive_aging_gate.sh`) retired with it; every other gate passed
unchanged.

**D2**: a reference is the cell's address. `ts_heap_ref_fast` tags only
`TS_GEN_NONHEAP` cells (bit 47, as before), `ts_ptr` is a mask,
`ts_same_cell` is bit equality, the write barriers read the owner's and the
value's gen bytes (owner first: most stores go to young owners), the array
and Map card barriers the value's, and identity hashes (Map/Set keys, the
class registry) come from the address: the high half of a 64-bit product,
because a 16-byte-aligned address put straight into a power-of-two table
would use a quarter of its home slots. The handle table, slot fixups, the
rewriting of promoted cells and pinning are gone, and so is the moving
collector's dead code. The young log stays, as pointers: a dying young cell
needs its visit (side buffers such as an ArrayBuffer's bytes, the heap
accounting); spinel's finalizer bitmap would make it unnecessary, a
follow-up. A full collection sweeps the old cells through their block
bitmaps (set bits whose cell is unmarked die and lose the bit), then the
young log. The marker takes a reference in the cage only when its header
reads as a live cell (a valid kind, YOUNG or OLD; references are made by
boxing a cell's first byte and a cell block keeps its size class, so only
a bug can name anything else), the production check of §4.7 in its cheap
form; outside the cage it is not a heap cell.

**Protect mode** (`TSAOT_GC_PROTECT=N`) quarantined released nursery chunks,
which D1 no longer has, so D2 rebuilds it for the cell space: a dying cell
is zapped and kept from the allocator (its bit stays set, its gen byte says
FREED) in a FIFO of up to N MiB, so a dangling reference reads poison rather
than a new cell, and a collection that reaches a quarantined cell aborts
naming it (a missing root or write barrier). Its first full run (every
conformance fixture at every allocation) found a silent miscompile older
than this work: `+` and the relational operators converted the first
operand with ToPrimitive and left the result unrooted while the second
operand's conversion ran, so a `valueOf` or `toString` that allocates could
free it; with handles its slot was recycled for another cell, with
addresses its memory is. `({ valueOf() { return "v-first" } }) +
({ valueOf() { churn(); return "-second" } })` printed a churned string
(fixture `gc/to_primitive_pairs`; the fix roots the result). The runtime
unit tests had one temporary of their own unrooted across allocations (the
ephemeron fixed-point test), and the freed-cell probes of the weak-map tests
ask the cell space now (`ts_gc_debug_cell_live`), since a stale address
does not turn NULL the way a freed handle did.

Measured against the build before D1 (eight interleaved pairs each, the
same generated C, outputs byte-identical):

| | wall | instructions | cycles | peak memory |
|---|---|---|---|---|
| tsc-ts, emitting the TypeScript 6.0.3 compiler | 0.887 (2.27 -> 2.01 s) | 0.879 (41.2 -> 36.2 G) | 0.884 | 0.931 |
| the TypeScript compiler compiling itself | 0.925 (4.23 -> 3.82 s) | 0.939 (77.2 -> 72.5 G) | 0.916 | 0.965 |

Both beat §6.7's estimate (about 4% and 6%), and every pair was faster.
The milestone: the second row is the TypeScript compiler compiling itself.
The selfhost bench (the frozen typed analyzer built by garnet, emitting its
own 42 MB IR) emits byte-identical C, also under protect mode, and matches
the frozen emitter on node on all 503 corpus fixtures that emitter handles:
wall 0.917 (125.5 -> 115.0 s, two ABBA pairs), instructions 0.892
(3234 -> 2885 G), peak memory 1.051 (624 -> 656 MB). The IR is exported
with the parity knobs: `scripts/typed_selfhost.sh` stops at its parity
stage before this work already, since the production export emits
`binding.check:` builtins the frozen emitter does not know. D2's builds of tsc-ts and the
compiler also ran under protect mode, protect mode with a minor collection
every 64 allocations, and zapping with one every 16: outputs identical.

Next, D3: `handle` and `gc_next` are dead, so the header can drop to 16 B
(§4.4) by removing them; the static-literal and stack-object initializers
of both emitters change with it (the frozen emitter's three templates are
the minimal fix the frozen-source rule allows, parity proving both emit the
same). The nursery's remains (its configuration, chunk code, aging
counters) go in a cleanup before it.

### 6.8.2 D3 as built: the 16-byte header

The cleanup came first (commit "Retire the copying nursery's remains"):
the chunk code, the chunk quarantine, aging and its counters, the
moving-minor switch and the stress gate's forced-moving modes went; the
remembered byte became a flag. D3 then removes the two dead header words:

```c
typedef struct ts_gc_header {
  uint8_t kind, mark, gen, remembered;
  union { uint32_t pin_word; struct { uint16_t spare; uint8_t inline_cap; uint8_t hdr_spare; }; };
  size_t size;
} ts_gc_header;   /* 16 bytes, asserted */
```

The static string literals' positional initializers lose their last two
elements and stack objects their `handle` store, in the Rust emitter and in
the frozen emitter's three templates (the minimal fix the frozen-source rule
allows: without it the frozen output no longer compiles; parity shows both
emit the same bytes, 376 identical). Against D2 (eight pairs each, outputs
identical): tsc-ts wall 0.992 (instructions 0.999, peak memory 0.929), the
TypeScript compiler wall 0.999 (instructions 1.002, peak memory 0.919):
time-neutral, 7-8% less memory. §4.4's further steps (the mark bit into the
bitmap, the size from the size class: an 8-byte header) remain.

### 6.8.3 D4: the allocator and the young sweep

A profile of the TypeScript compiler after D3 put a fifth of its time in
allocation and collection: the run search of the refill 7%, the young sweep
(visiting every young cell, dead ones included) and the per-cell memset
about as much again. Three slices, each its own A/B (eight pairs per
program, outputs identical):

- **D4a**: a block's next free run is found a bitmap word at a time. Bits
  are set only at cell starts, so the run starts at the first cell start
  whose bit is clear (per class, the cell starts are precomputed as bitmap
  words) and ends at the next set bit; the refill had walked a block dense
  with survivors a cell at a time. tsc-ts 0.987, the compiler 0.986.
- **D4b**: a run is zeroed when the allocator takes it (one memset; the
  hardware zeroes whole cache lines) rather than each cell when it is
  handed out; ASan builds keep the per-cell zeroing. 0.989 and 0.989.
- **D4c**: a collection does not visit the young cells that die. The marker
  lists the young cells it reaches and the collector promotes them from the
  list; only the kinds whose death frees memory outside the heap
  (ArrayBuffer bytes, promise waiters, coroutine side arrays) and large
  cells are logged when allocated, and every other dead young cell is free
  because no bit covers it. The heap byte count becomes the old cells' bytes
  plus the cycle's young bytes, reset at each collection. The debug modes
  (zap, protect, ASan, the statistics build, the unit tests) still log and
  visit every young cell, and there a dead cell owning a malloc'd buffer
  aborts: that buffer would leak in production. The check found one at
  once: the Map and Set iterators allocated their insertion-order array with
  `malloc`, not as a payload of the collection. 0.989 and 0.983.

## 7. Verification

- Gates of every slice: unit, parity (`scripts/emitc_diff.sh`), bundler,
  selfconf, GC stress (O2, ASan, runtime), inline policy, conformance (all
  tiers), the compile A/B with outputs compared.
- New stress modes as the slices need them: `TSAOT_GC_VERIFY_REFS` (decoder
  verification, G4), zapping of freed payload cells (G2) and of dead cells
  (G3), `--stack-check` runs when allocation paths change.
- The milestone (§6) for G2, G3, G4, G5.

## 8. Open questions (answered by G0 or the slices)

- Size classes and the share of cells above 4 KiB.
- How many dying young cells own payloads, and how many bytes (G2's gain).
- Young survival per kind: does the eden pool stay hot (G3's risk)?
- Remembered-set traffic without the value filter (if the barrier is
  simplified to the owner test only).
- Whether premature promotion without aging costs full collections.

## 9. G0 results

Statistics runtime (`-DTSAOT_RT_STATS`, the G0 counters) relinked with the
`x69` compiler object; one compile with emit for the counts, three with
`TSAOT_G0_FATES=0` for the phase times (the per-cell accounting inflates the
sweep). Statistics builds run slower than production; the times are for
proportions.

- **Allocation**: 16.0M cells, 2.03 GB (payloads excluded): objects 5.60M,
  arrays 4.48M, strings 4.46M, functions 0.96M, Maps 0.26M, coroutines 98k
  (1,280 B each), promises 98k. Pretenured 2.21M cells (367 MB); the rest,
  13.8M cells (1.66 GB), start young. Every cell receives a handle (16.0M
  issued, 12.2M freed; at most 3.85M ids live, a 4.19M-entry table).
- **Fates of young cells**: 12.1M die young (1.44 GB, 88% of young cells);
  1.62M are promoted (227 MB: 12% of the cells, 14% of the bytes); aging kept
  0.66M cells young for one more collection, and only 5 MB of them died in
  that grace against 93 MB promoted: **aging buys almost nothing here**, so
  Y2's promotion at first survival costs little.
- **Old generation**: 3.81M cells, 590 MB at exit (objects 2.79M / 433 MB)
  plus 80 MB of payloads; the three full collections free 21.6k cells
  (3.8 MB). The old generation is almost entirely live.
- **Payloads**: 1.36M of the 12.1M dying young cells own malloc'd buffers
  (11%), 95 MB in total: closure environments 943k (35.7 MB), Map buffers
  113k (28.7 MB), element buffers 45k (21.6 MB), shaped value vectors 112k
  (4.4 MB), Set buffers 48k (4.8 MB), coroutine side arrays 98k.
- **Sizes**: 98.9% of all allocations are at most 256 B, 82.5% at most 128 B;
  3,548 cells exceed 4 KiB. Arrays are all 128 B, functions 128 B, Maps
  144 B, 80% of strings 80 B (a 64-byte string header around a short
  content), objects 80-192 B. Thirty-nine size classes (16-byte steps to
  256 B, then 12.5%) waste 0.4%.
- **Collection time** (median of three, statistics build): 368 minors,
  273 ms — marking (roots, remembered set, young closure) 126 ms, nursery
  sweep (visiting every cell: handles and payloads of the dead, copy or
  promotion of the survivors) 97 ms, promoted-slot rewriting and the
  promotion barrier 32 ms, remembered-set reset 11 ms, unpooled sweep 7 ms;
  3 full collections, 42 ms — marking 32 ms, old sweep 8.5 ms. About
  320 ms in all.
- **Remembered set**: 3.1M enrollments, 3.02M remembered cells rescanned by
  minors (8.2k per minor; 14.1M slots, 12.5M of them through dirty ranges).
- **Prototypes**: 7 lazily materialized per compile (G1 (a) matters only for
  runs without collections).

Consequences for the plan:

1. Under Y2 the nursery sweep and the rewriting disappear (about 130 of the
   320 ms) together with the per-allocation handle; the minor marking
   (126 ms) remains and becomes the largest collector cost: parallel marking
   (G7) should cover minor collections too, not only full ones.
2. Size classes are simple: 16-byte steps up to 256 B serve 98.9% of the
   cells; a large-object space for a few thousand cells.
3. G5 matters more than §6 assumed: a 16-byte header saves 256 MB of the
   2.03 GB, and a compact string header (most strings are 80 B cells with
   a 64-byte header) another 140 MB or so; arrays and functions sit at 128 B.
4. Payloads in the heap (G2) save 1.36M frees and as many mallocs per
   compile for the dying young cells alone; their main value is that dead
   young cells then need no visit at all (a precondition of Y2).
