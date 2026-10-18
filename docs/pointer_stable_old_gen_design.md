# Pointer-stable old generation — direct references to old cells

Track B of `docs/v8_parity_roadmap.md`. Builds on the handle-table generation
bit, typed cells, capture contexts, in-object slots and frame slot coalescing
of Session 350.

## Problem

Every heap reference is a handle: the payload is `(slot << 1) | 1` and
`ts_ptr` loads `g_ts_handle_table[slot]` before it can touch the cell. The
table is large and accessed at random, so most property reads, calls and
collector edges pay one dependent, often cache-missing load before the cell
itself. The handle exists so that nursery cells can move without their
references being found; old cells never move (the old generation is
malloc'd, full-collection compaction is disabled), so for them the
indirection buys nothing.

## Representation

A heap reference has one of three payload forms, told apart by the low bits
of the 16-byte-aligned payload:

- **handle** (`bit 0 = 1`): `slot << 1 | 1`, as today; the only form a
  reference to a young cell may take.
- **old pointer** (`bits 1..0 = 00`): the cell address; only for cells in
  the old generation, which never move.
- **stack pointer** (`bit 0 = 0`, `bit 47 = 1`): the address of a
  stack/SROA/static cell (`TS_GEN_NONHEAP`), which the collector scans but
  never moves or frees. Today these are plain even payloads; the tag lets a
  minor collection skip old pointers without loading the cell. The tag sits
  above the user address space because static string literals and stack
  cells are only 8-byte aligned (the first attempt used bit 1 and silently
  truncated every literal's address).

`ts_ptr` masks the tag bit (one AND on the even path). Boxing
(`ts_heap_ref_fast`) returns the old-pointer form when the cell's generation
is old, the handle form while it is young, the stack form for non-heap cells.
The handle table keeps its entry for an old cell (handles stay valid for the
cell's lifetime), so a handle-form reference that the collector never saw
keeps working.

## Identity

Two references to one cell may differ in form (a handle made before the cell
was promoted, a pointer made after), so identity can no longer be the bit
pattern alone. `ts_same_cell(a, b)` is the rule: equal bits are equal; bits
that differ in form (one odd, one even) with the same selector compare
`ts_ptr(a) == ts_ptr(b)`; bits that differ within one form are different
cells (handle slots and addresses are unique among live cells). The
comparison costs nothing extra until the forms differ. Sites: `===`
(`ts_strict_eq`), `Object.is`, SameValueZero (Map/Set/includes), `instanceof`
and other prototype-chain walks, the class registry lookup by prototype;
caches that guard on a prototype (`ts_prop_ic` locations, the addition
cache) may miss on a form mismatch and simply refill. Map/Set hashes already
use the cell's handle id (`sv0_hash`), which both forms reach.
`TSAOT_IDENTITY_CHECK=1` (runtime debug mode) evaluates every identity site
both ways and aborts on disagreement.

## Collector

- Marking: a handle-form edge classifies from the table entry as today; an
  old-pointer edge is skipped by a minor collection without any load; a
  stack-pointer edge is scanned as today. Full collections mark through the
  pointer directly.
- Rewrite: the scanners visit slots (`tsv*`) instead of values. When a slot
  holds a handle to a cell that is already old, the slot is rewritten to the
  old-pointer form on the spot. When the target is promoted in the same
  minor collection, the slot is recorded (stable slots only: roots, frames,
  old cells of the remembered set) and rewritten after evacuation, and every
  promoted cell's own slots are rescanned after evacuation so that cohorts
  promoted together reference each other by pointer. Slots of cells that
  stay young are visited again by the next minor collection.
- Write barrier: an old-pointer owner is old by construction; a value in
  pointer form needs no barrier (it is old or stack); a handle-form value
  classifies from the table as today.
- Sweeping and freeing are unchanged: a cell is freed only when unreachable,
  which pointer-form references respect exactly as handles do.

## Invariants

1. A young cell is referenced only in handle form.
2. An old cell never moves; its handle table entry stays valid until it is
   freed.
3. Every identity decision goes through `ts_same_cell` (or a hash of the
   handle id); no runtime or generated code compares two heap references by
   bits for identity.
4. The collector sees every reference that lives across a collection (frames,
   roots, remembered set, young cells), as it already must for handles.

## Slices

- **B1 — identity.** `ts_same_cell`, the identity sites, the debug check
  mode, the stack-pointer tag in `ts_heap_ref_value` and the mask in
  `ts_ptr`. No pointer forms are produced for old cells yet; measurable on
  its own (expected flat).
- **B2 — pointer forms.** `ts_heap_ref_fast` boxes old cells as pointers;
  slot-based scanning with the rewrite in minor and full collections; the
  write barrier fast paths. Gate: full set, GC stress with forced moving and
  the identity check mode, the compiler under the identity check, then A/B.
- **B3 — branch-free `ts_ptr`** (optional, measured): select between the
  table entry and the payload without a branch.

## Expected effect

Property reads, calls and other accesses to long-lived data (nodes, types,
symbols, the checker's tables) lose one dependent load; minor collections
skip old targets without touching the table. Costs: one generation load
when boxing a raw pointer, one AND on `ts_ptr`'s even path, and the identity
slow path when forms differ.
