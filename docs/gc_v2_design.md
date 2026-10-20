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
  depending on the collector's state. (b) Payload bytes count toward the
  minor trigger (TODO (0)). (c) The nursery zeroes a chunk when it is reset
  instead of each cell on allocation, keeping the zero-init contract.
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
