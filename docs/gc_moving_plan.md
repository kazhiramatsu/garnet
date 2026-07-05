# Generational Moving GC Implementation Plan (v1, 2026-07-03, session 316)

User decision: **make the GC a generational moving GC**. This document is the implementation plan.
Relationship to the master plan: it pulls P6 (bump nursery / lazy handle) forward and merges in the GC-adjacent items of P2a.
The reference values for perf judgments come from `docs/refactor_baseline.md` (2026-07-03 measurement window).

## 0. Accurate Assessment of the Current State (ts_rt.c, measured, as of s316)

What already exists (assets up through §313):
- **Generational separation**: young/old lists + `TS_GEN_NONHEAP` (stack/SROA direct pointers).
  The threshold is based on **object count** (young 65,536 / full 262,144; after a full it is reset to live×2).
- **remembered set + write barrier**: `ts_write_barrier(owner, value)` (inlined at ts_rt.h:1139;
  on an old→young store it calls `ts_gc_remember`). Coroutines conservatively re-remember on every GC.
- **minor moving is ON by default**: live cells are **shallow-memcpy'd** into a freshly malloc'd cell
  (payload arrays such as props/env are moved pointer-and-all) → **the handle table is repointed**
  (`gc_handle_move`) → the old cell is freed. Because the bit pattern of a tsv is a handle id,
  **no reference rewriting is needed at all** (this design is what makes moving correct). Immovability is
  expressed by pinning (`pin_depth`). The only current source of dynamic pinning is the single site
  `ts_coro_resume_v`.
- **Precise roots**: an explicit root stack (`ts_gc_root(&local)` registers a tsv*; since it becomes
  address-taken, the compiler reloads it from memory across an opaque call) + the symbol table + async roots.
- A suite of moving-tolerance conformance tests (moving_minor_relocation / generational_remembered_set /
  *_safepoints / the MOVE_CORO and MOVE_PROMISE forcing flags).

What is missing (= the target of this plan):
1. **The allocator is calloc/cell + handle/cell + linked list**. It gets none of moving's payoff (bump allocation).
   Measured: gc_shortlived 3M alloc = 175ms, handle_alloc == alloc_count (every alloc consumes a handle).
2. **Marking is recursive** → deep pointer chains (on the order of 10^5) SIGSEGV (discovered in s316; crash report confirmed).
3. Every reference is indirected through the handle table (one dependent load per deref; `ts_heap_ptr` is inlined in ts_rt.h).
4. The threshold is count-based rather than byte-based (with variable-length cells, especially strings, it misestimates pressure).

Notes (out of scope for this plan but adjacent):
- The closure `env_malloc` (4M calls / 222ms) is **not a GC cell but a temporary scratch array in ts_call**
  (in ts_rt.c's ts_call: malloc → call → free). It is resolved by P2a's "stack-buffer conversion" as a separate item.
- The O(n) scan in Map/Set (probe 2,219) is also P2a. However, **the hash design for object keys interferes
  with Phase C** (see §Phase C risks) — address-derived hashes are forbidden.

## 1. Target Architecture

```
young = ①bump nursery (contiguous chunks, small movable cells only, alloc = pointer bump)
        ②unpooled young (the legacy malloc list: large cells, coro/promise, expected pin candidates)
minor GC = worklist mark → evacuation-copy nursery survivors into old (reuses the existing move path)
           + unpooled young is swept as before → the arena is bulk-reset
old   = malloc cells, mark/sweep (stays non-moving; compaction is a data-driven decision in Phase D)
refs  = in Phase C, handle indirection is entirely eliminated in favor of direct pointers + Cheney rewriting during evacuation
```

There are 4 stages. **A (safe foundation) → B (bump nursery = the main event) → C (reference overhaul) → D (optional)**.
Each phase lands independently and can be stopped at any time (even just up through B is a worthwhile configuration).

---

## Phase A — Convert Marking to a Worklist (behavior-preserving, crash fix)

**Goal**: replace the recursive `gc_scan_refs`/`gc_scan_young_refs` with an explicit stack. Fixes the deep-chain SIGSEGV.
Do this first, because every phase from B onward uses the same traversal during evacuation copying.

Changes (within ts_rt.c, ~200 lines):
- A shared growable stack `g_markstack` (initially 8,192 entries, ×2 growth, reused across GCs;
  growth failure aborts loudly). mark-on-push (set the mark at push time to prevent duplicate pushes).
- **Unify** the per-kind field enumeration **into a single iterator**, with full/minor sharing it via thin wrappers
  (currently there is a double implementation, gc_scan_refs / gc_scan_young_refs — dedup it while preserving behavior).
- NONHEAP (stack/SROA) cells are currently scanned without a mark guard. As part of the worklist conversion,
  introduce "mark on push + record on a visited list → bulk-clear the marks at GC end"
  (NONHEAP cells are not on the sweep list, so they need an explicit clear. This closes both the theoretical
  stack-object cycle and duplicate scanning).
- The enumeration of coro frames / async roots is unchanged.

**New tests**:
- `benchmarks/gc/gc_deep_chain.ts`: build a single chain of ~300,000 nodes → force a minor GC → scan
  checksum. **It currently SIGSEGVs (= proof of the fix)**. After the fix it doubles as a bench and a deep-mark pause metric.
- Add a ~150,000-node version to conformance (a new `exhaustive/gc/` or an existing category) (with the default
  threshold, at least one minor is guaranteed). **Do not put it in the gate gc FILTER** (with threshold=1 it becomes
  quadratically slow. The FILTER is an explicit list, so it won't be added on its own).

**Exit criteria**: the deep-chain fixture is dt OK (currently SIGSEGV → PASS) / bench_gc ABAB shows wall and pause
differences within noise / gate gc O2 PASS / conf all 330 + bundler 39 / gate bench 99 within budget.

Scale: within one session, a single commit.

---

## Phase B — bump nursery (performance of the moving GC, the main event)

**Status (s317)**: B-1 (arena + allocation) / B-2 (evacuation copy, pinned evacuation, full unification) implemented and verified.
**Only B-3 (byte-based threshold) is not yet started** (to be done next time together with optimizing full frequency for survivors).
Measurements are in the "B measured" column of the exit-criteria table below.

**Goal**: turn young into a contiguous arena so that alloc = pointer bump and free = bulk arena reset.
Drive the cost of dead short-lived objects to near zero (today even dying cells incur calloc + free + handle).

### B-1 Arena and allocation path
- Chunks of 256KB × N (`posix_memalign` for 256KB alignment — groundwork for Phase C's pointer→chunk reverse lookup
  and retained-chunk management). Default capacity 4MB (equivalent to the current 65,536 objects × 64B average ≈ 4.2MB).
  Override with `TSAOT_GC_NURSERY_BYTES`.
- **`TSAOT_GC_YOUNG_THRESHOLD` (count) is kept for compatibility**: when set, it triggers on the OR of
  "byte exhaustion or count reached" (this preserves the threshold=1 stress semantics of gate gc).
- fast path (a chain of **single predicted branches**, per hot-path discipline):
  small (< 4KB) and a movable-kind and not coro/promise → bump allocation
  (`memset(cell,0,sz)` — some code depends on the current calloc zero-initialization, so keep it for now.
  `h->size` must always store the actual size = required for linear walking of the arena).
- slow path: large cells (such as the 500MB-class inline strings in gc_strings) and coro/promise go to
  **unpooled young (the legacy calloc + young list)** — the legacy code as-is.
  Why large cells are not sent straight to old: today's measurements show large short-lived strings are reclaimed
  immediately in minor (gc_strings minor=6/full=0), so sending them straight to old would make them linger until
  a full and worsen RSS.
- Handles in B are **still issued for all cells as before** (B = memory layout, C = reference scheme, keeping the concerns separate).

### B-2 minor GC (evacuation copy)
- Marking (A's worklist) is unchanged.
- Liveness determined by **linear arena walk**: marked → reuse the existing `gc_move_young_to_old`
  (malloc + shallow memcpy + handle repoint) to evacuation-copy into old / unmarked → only free the payload via
  `gc_free_cell` (the cell body belongs to the arena; do not free(h) it). unpooled young uses the legacy logic as-is.
- After the scan, reset the bump of all chunks (chunks are retained and reused; no realloc churn).
- **pin handling (defensive path)**: since coro/promise are isolated to unpooled, "pinned inside the arena" does not
  occur in the current configuration (the only dynamic pin is coro resume). But as a defense:
  a chunk containing pinned cells is moved to a retained list, and those cells are tracked on a "pinned young list"
  (reusing gc_next) → at the next minor, if the pin has been released, they are evacuation-copied and the chunk is freed.
  A `retained_chunks` counter in `RT_STATS` (**should be 0 in all benchmarks** — a nonzero value is a sign the design
  premise has broken).
- **Unifying the full GC**: the current full does an in-place gen-flip of young survivors, but arena cells cannot be
  promoted in place (their cell memory is embedded in the chunk, which is inconsistent with old sweep's free(h)).
  → **arena cells are evacuated by evacuation copy even in a full GC** (consolidating to "an arena cell either leaves
  by copy or dies"). unpooled young does the gen-flip as before.

### B-3 Byte-based threshold
- Move the full trigger from count to **live-bytes based** (the `alloc_bytes`-family accounting already exists in RT_STATS.
  Promote just the byte accounting to an always-on counter even in non-stats builds). The reset rule follows live×2 +
  a minimum headroom. For the nursery, its capacity itself is the budget.

### Verification / exit criteria
- correctness: gate gc O2 (threshold=1 becomes the strongest stress, hitting **evacuation copy on every alloc**)
  + the MOVE_CORO/PROMISE/BOTH matrix + conf all + bundler + gate full.
- perf (bench_gc ABAB, idle machine; since ts_rt.h is unchanged, the rt.o swap protocol is valid):

| Metric | Current (s316) | B exit target | **B measured (s317 ABAB, old→new)** |
|---|---|---|---|
| gc_shortlived wall | 175ms | **≤ 100ms** | 160→**135ms (-15.6%)** not met※ |
| gc_binarytrees wall | 116ms | ≤ 90ms | 107→**99ms (-7.5%)** near miss |
| gc_escape_poly wall | 151ms | ≤ 110ms | 136→**118ms (-13.2%)** near miss |
| gc_survivors max pause | 6.32ms | ≤ 6.5ms (non-regression) | 6.97ms (the arena evacuation-copy portion of full GC; full-side frequency to be optimized by B-3's byte threshold) |
| gc_strings / gc_cycles / mapset | 1096 / 48 / 750ms | non-regression (within noise) | 1073/**25 (-29%)**/747ms ✓ (+ closures 202→172, deep_chain 33→28) |
| gate bench | 99/99 within budget | 99/99 maintained (gc_churn-family budget 100/160ms) | **99/99 PASS** ✓ |

※ **Lesson from the s317 measurements**: the residual cost of shortlived after bump conversion is not GC pause
(total pause 28.65ms/136ms) but **the per-alloc handle churn on the mutator side** (3M alloc = 3M handle_alloc,
remaining even at 100% nursery coverage). ≤100ms is **deferred to the exit of Phase C**, which eliminates handles
entirely (the C target ≤60ms remains reasonably in place). The nursery itself works as designed: 100% bump coverage
across all benchmarks, retained_chunks=0 (the pin-evacuation path was demonstrated end-to-end with a dedicated probe
using a JSON.parse function-value call + threshold=1, retained=1 → reclaimed).

- **kill-switch**: keep an env `TSAOT_GC_NURSERY=0` that drops all kinds to unpooled (= the current allocator) for just
  one milestone period (single predicted branch, per hot-path discipline). Remove it after the selfhost milestone is green.
- Milestone (a measurement window requiring user agreement): a wall/RSS comparison of selfhost native emit.

Scale: ts_rt.c ~500 lines, commit split into 4 (alloc path / evacuation copy / full unification / threshold + stats).
2–4 sessions.

---

## Phase C — Overhaul of the Reference Scheme (fully eliminate handle indirection)

**Goal**: turn tsv from a handle id into a **direct pointer**. deref = mask + cast (removing one table lookup),
eliminating the handle-issuance cost (which today every alloc bears) and the handle table itself. The biggest lever on mutator speed.

**Method**: perform **Cheney-style reference rewriting** during nursery evacuation copy.
- Leave a forwarding pointer in the from-cell's header (repurposing the handle field).
- Each time a reference is encountered: if not yet evacuated, evacuate and rewrite / if already evacuated, rewrite to the forwarded location.
- Rewrite targets = rooted slots (via tsv*, C locals get rewritten too — the root discipline directly becomes the
  visibility discipline) + all cell fields reached during the scan + the remset + coro frames + the symbol/async tables.
  Since old is non-moving, direct pointers into old are permanently stable = no handle needed.
- Stages: **C0 audit + groundwork → C1 direct-pointer switchover (flag day) → C2 remove the handle table → C3 shrink
  the header (removing the handle u64 takes 32B→24B, repurposing a u32 for the identity hash)**.

**Premises to clear in C0 (entry conditions)**:
1. **ASan recovery is required** (a CLT update or a real homebrew GCC. C1 is frozen until the startup deadlock discovered
   in s316 is resolved. **Reconfirmed in s318: still CLT 17.0.0; even `int main(){}` still deadlocks**).
   `TSAOT_GC_ZAP` was **introduced in s318** (fills moved-from / dead cell bodies with 0xDD, env-gated, GC cold path only;
   the gate gc ZAP row and the worst-case combined probe (minor=1 × forced full × pin) are green).
   Remaining: a **full conformance-fixture run** with ZAP + threshold=1 (to clear out the C0 root-leak inventory;
   since it takes a measurement-window-scale amount of time, do it after agreeing on a window with the user).
2. **Interference with the P2a Map/Set hash**: the hash for object keys must **not be address-derived**.
   **Design finalized (s318)**: hide it behind a single API `ts_obj_identity_hash(tsv)` (inline), and P2a uses only this.
   **Stored value = the raw unique id** (distribution is applied on the hash-table side via a fibonacci mix
   `id * 2654435769u >> shift` — by not mixing the stored value, the origin of the id can be swapped out in the future).
   The implementation migrates in stages:
   - **B era (now)**: the low 32 bits of the handle id (already unique per cell, invariant under move, zero added cost).
   - **C1 onward**: at the same time as handle removal, **lazily assign** into the u32 freed from the old handle region in C3
     (assigned from a global counter on first reference; 0 = unassigned. Since moving memcpy's the whole header, it follows automatically).
     The switch is a single site in the `ts_obj_identity_hash` implementation.
   - Prohibitions: address-derived (breaks under moving) / having the Map implementation read the handle directly
     (disappears in C) / storing a pre-mixed hash in the stored value (a form that becomes non-recomputable when the
     table size changes is not allowed; standardize on storing the raw id + mixing at use time).
3. **coro × setjmp/longjmp audit**: confirm on the emit side that live values crossing a yield are spilled into the frame
   cell (scannable / rewritable). tsv's held in registers across an allocating call within a resume span are subject to
   the root discipline (today the handle serves as an indulgence for them; in C, a root leak = an immediate wild pointer.
   Smoke it out with the three-tier gate gc threshold=1 + ZAP + ASan).
4. Enumerate the known classes of root leaks: today's moving "doesn't notice as long as the handle is alive even if leaked" —
   before C, run all of conformance to completion with `TSAOT_GC_ZAP` + threshold=1 to pick out the latent leaks first
   (this is itself a valuable correctness hardening).

**Caution**: C1 changes the ts_rt.h inlines (`ts_heap_ptr` etc.), so **the rt.o swap ABAB does not hold**. Take A/B by
"fully building the same generated C with each of the old and new header + rt" (fixture cc is 134ms, selfhost cc is also
6.3s, so it's realistic). Do not double up old and new via env (in the spirit of no double implementation; switching is
one shot via branch + stress matrix, reverting is a revert).

**Exit criteria**: handle_alloc = 0 / gc_shortlived **≤ 60ms** / expanded budget headroom on obj_kernel etc. /
a measurable improvement on selfhost native emit / the entire stress matrix (threshold=1 × MOVE matrix × ZAP × ASan) green.

Scale: 3–6 sessions (the C0 audit is heavy). **Formal go/no-go after seeing B's measurements**.

---

## Phase D — Cleanup of the old Generation (optional, data-driven)

- old compaction (mark-compact) is possible by generalizing C's rewriting machinery, but
  **do not do it until real RSS/fragmentation data justifies it** (using mimalloc alongside is already a mitigation).
- pause control (adaptive nursery capacity / incremental old marking) waits until a pause target overrun is observed on
  a real workload of the selfhost-native class. The current max 7.4ms (100,000 live) is plenty small for CLI AOT use.

---

## Cross-cutting Protocol

- **Per-commit verification**: the daily measurement set (compile A/B ~4s + bench_gc ~30s + gate bench 63s + gate gc O2)
  ≈ 2 minutes. gate full (767s) at phase boundaries. Heavy sets (selfhost native / typed / full engine rows) are
  **only in a measurement window agreed with the user** (low-load binding, s316).
- **A/B is same-conditions ABAB** (the lesson that absolute values under machine load are untrustworthy). Up through B it's
  the rt.o swap; C is a full-build comparison.
- Every phase is self-contained within ts_rt.c (no emit/exporter changes. The only exception is C0's coro-spill audit,
  which reads emit read-only). It can run in parallel with P1's emit_c.rs split, but **serialize commits with the
  ts_rt.c-touching P2a items (Map/Set, intern, find_prop, env stack buffer)** to avoid conflicts.
- Progress goes to the end of TODO.md, confirmed values are appended to refactor_baseline.md (this document is revised when a judgment changes).

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| ASan recovery is delayed | C cannot be started | A/B can proceed ahead with O2 stress + ZAP. Try a CLT update or brew gcc early |
| Latent inventory of root leaks | Wild pointers in C | Pick them out first with C0's ZAP + threshold=1 full-conformance run |
| Hidden dependence on calloc zero-init | Undefined behavior in B | Keep equivalence for now with bump + memset → later trim per-kind |
| Unexpected occurrence of in-arena pin | The chunk-evacuation path activates | Monitor retained_chunks counter = 0 + put the defensive implementation in from the start |
| P2a hash designed as address-dependent | Map breakage in C | Finalize the identity hash in C0 and supply it to P2a |
| Misjudging retention of large cells | RSS worsens | Keep large cells in unpooled young (do not send straight to old) to preserve current behavior |

## Open Items (User Decision)

1. **Order of work**: the recommendation is A → B in succession. Whether to slot P2a (Map hash etc.) before B is a matter
   of preference (the bench's mapset 760ms stands out, so there is value in doing it first, but now that the GC direction
   is decided, the recommendation is A→B to lock in the skeleton of moving first).
2. **Timing of the CLT / Xcode update** (a premise for C; not needed up through B).
3. **The milestone measurement window at B completion** (selfhost native comparison; requires agreement on a time window).

## Estimates

| Phase | Scale | Dependencies |
|---|---|---|
| A worklist conversion | ~1 session | none (can start now) |
| B bump nursery | 2–4 sessions | A |
| C reference overhaul | 3–6 sessions | B + ASan recovery + identity hash design |
| D old cleanup | depends on data | C (monitor on the premise of not doing it in principle) |
