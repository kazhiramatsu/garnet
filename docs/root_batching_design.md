# Root batching — shadow-frame design (v1, 2026-07-09, s321)

Replaces per-local `ts_gc_root`/`ts_gc_unroot` calls in generated function prologues with
ONE inline frame push/pop per function. Attacks the #2 flagship cost (GC root churn ≈ 15%
of samples; `root_push` = 4,028,710 on a 125 KB input — see `docs/runtime_perf_plan.md`
§1.1 F13). Expected: ~10× fewer root-stack operations AND extern-call → 3 inline stores.

**This document is written to be implemented step-by-step by a low-capability agent.**
Every step names exact files, functions, and line anchors (verify each anchor before
editing; if drifted, re-locate by identifier, not line). Do the steps in order; each is
one commit; never combine steps.

## 0. Read first, in this order

1. `docs/TODO.md` — tail only (current repo state; CLAUDE.md rule).
2. `docs/runtime_perf_plan.md` §2 (C1 failure rules R1–R6), §3 (ground rules, verification
   recipe §3.4, GC-discipline rules §3.9), §8.1 (why shadow frames won over the mruby
   arena and conservative scanning — do NOT re-litigate here).
3. This document, fully, before writing any code.
4. `docs/agent_workflow.md` — build / dt / gate mechanics.

Prerequisites: plan §5.0 items 1.5 and 1.4 landed (or explicitly waived by the user).
This change is **emit-affecting** (unlike 1.1–1.5): the parity consequences are handled in
Step S5 and MUST NOT be triggered earlier.

## 1. Problem (pre-implementation state, with real output)

Generated prologue today (from the selfhost build; one function, 17 reflike locals):

```c
tsv v13 = TS_UNDEFINED;            /* decl+init per local */
...
if (nargs > 0) v0 = args[0];
ts_gc_root(&v0);                   /* extern call × 17 */
ts_gc_root(&v2);
...
ts_gc_root(&v18);
/* body */
ts_gc_unroot(17);                  /* before each return */
```

`ts_gc_root` (runtime/ts_rt.c:361-368) is an extern call doing a growth check + slot-store
+ len++ on the global `g_roots` array (decl at ts_rt.c:98). Per function invocation:
N extern calls + 1 extern call. The selfhost generated C contains 34,566 static
`ts_gc_root` sites; the medium-slice dynamic count is 4.03 M pushes.

## 2. Design overview

Reflike locals move into ONE stack struct per function; the struct is linked into an
intrusive singly-linked list the GC walks. Registration = 3 inline stores; deregistration
= 1 inline store; no growth checks; no per-value calls.

```c
static tsv fn_N_xxx(tsv* args, int nargs){
  double d1 = 0, d7 = 0;                       /* unboxed locals: unchanged, stay outside */
  struct { ts_frame_hdr h; tsv v0, v2, /*…*/ v18; } F;
  F.v0 = TS_UNDEFINED; F.v2 = TS_UNDEFINED; /*…*/ F.v18 = TS_UNDEFINED;
  if (nargs > 0) F.v0 = args[0];
  if (nargs > 1) d1 = ts_to_num(args[1]);
  ts_frame_push(&F.h, 17);
  /* body — every `vN` reference becomes `F.vN` (mechanically, via Step S2/S3) */
  ts_frame_pop(&F.h);
  return r;
}
```

Correctness intuition (why this is exactly as safe as today): the GC sees the same set of
tsv slot addresses as before — only the registration mechanism changed. Locals were
ALREADY address-taken and memory-resident (today's `ts_gc_root(&v0)` forces that), so C
optimizer behavior is unchanged. Neither failure direction of conservative scanning exists
(see plan §8.1 Design B rejection). Frames on the C stack are always fully initialized
before being linked (§5 S3 ordering), and there is no allocation between member init and
push (no calls are emitted in that window).

## 3. Data structures and runtime API (exact code)

### 3.1 runtime/ts_rt.h — add near the `ts_gc_root` declarations

```c
/* Shadow root frame (root batching): generated functions register all their
   reflike locals as ONE contiguous frame instead of N ts_gc_root calls.
   The frame struct lives on the C stack of the generated function:
     struct { ts_frame_hdr h; tsv v3; tsv v5; ... } F;
   Invariants:
   - slots (the tsvs immediately after the header) are fully initialized to
     TS_UNDEFINED before ts_frame_push (the GC may run at any later call).
   - every function that pushes MUST pop on every exit path; exception unwinds
     restore g_frame_top from the handler snapshot instead (see ts_eh_*).
   - runtime-internal code keeps using ts_gc_root/ts_gc_unroot; both root sets
     are scanned by the GC. */
typedef struct ts_frame_hdr {
  struct ts_frame_hdr* prev;
  uint32_t count;                    /* number of tsv slots following the header */
} ts_frame_hdr;
extern ts_frame_hdr* g_ts_frame_top;

static inline void ts_frame_push(ts_frame_hdr* f, uint32_t n){
  f->prev = g_ts_frame_top; f->count = n; g_ts_frame_top = f;
  TS_RT_STAT_FRAME_PUSH();           /* macro defined empty unless TSAOT_RT_STATS */
}
static inline void ts_frame_pop(ts_frame_hdr* f){
  g_ts_frame_top = f->prev;
}
static inline tsv* ts_frame_slots(ts_frame_hdr* f){ return (tsv*)(f + 1); }
```

Note on the stats macro: hot-path stats in ts_rt.h inlines must compile to `((void)0)` in
default builds (same convention as existing `RT_STAT_*`; those live in ts_rt.c, so define
a tiny `TS_RT_STAT_FRAME_PUSH` hook in ts_rt.h guarded by `TSAOT_RT_STATS`, incrementing
an `extern` counter defined in ts_rt.c).

### 3.2 runtime/ts_rt.c — definition, GC walk, exception snapshot

1. Define the global next to `g_roots` (anchor ts_rt.c:98):
   `ts_frame_hdr* g_ts_frame_top = NULL;` (+ the stats counter if TSAOT_RT_STATS).
2. **GC walks — add the frame scan in BOTH mark phases**, immediately after the existing
   `g_roots` loops:
   - young mark: anchor ts_rt.c:2710-2713 (`gc_mark_value_young(*g_roots[i])` loop)
   - full mark: anchor ts_rt.c:2809-2812 (`gc_mark_value(*g_roots[i])` loop)
   ```c
   for (ts_frame_hdr* fr = g_ts_frame_top; fr; fr = fr->prev){
     tsv* slots = ts_frame_slots(fr);
     for (uint32_t i = 0; i < fr->count; i++) gc_mark_value_young(slots[i]); /* or gc_mark_value */
   }
   ```
   (No `__asan_unpoison_memory_region` needed: frames are live C-stack objects, unlike the
   g_roots slot pointers which may point into poisoned regions — if ASan complains during
   gate gc, STOP and investigate; do not blanket-unpoison.)
3. **Exception handler snapshot** — the handler already snapshots the root depth; add the
   frame-top snapshot in exactly the same places (pair every `gc_root_len` use):
   - find the handler struct + capture sites: `grep -n "gc_root_len" runtime/ts_rt.c`
     → capture at ts_rt.c:8836 and :8847 (`h->gc_root_len = ts_gc_root_depth();`)
     → add field `ts_frame_hdr* frame_top;` to the handler struct and
       `h->frame_top = g_ts_frame_top;` at both sites.
   - landing sites ts_rt.c:9126-9127 and :9423-9426
     (`if (setjmp(h->buf) != 0){ ts_gc_set_root_depth(h->gc_root_len); ...`)
     → add `g_ts_frame_top = h->frame_top;` right next to each depth restore.
   Rationale: a longjmp discards any number of C frames of converted functions; restoring
   `g_ts_frame_top` to the try-entry snapshot unlinks ALL of them in O(1), exactly like the
   depth restore does for g_roots. This is correct regardless of which functions are
   frame-converted, so the runtime part is complete before any emitter change.
4. There is also a **generated-code** restore of handler depth: emit_c.rs:7035 emits
   `ts_gc_set_root_depth(_h->gc_root_len); ts_eh_pop();`. In Step S3 the emitter adds the
   frame analog next to it (`g_ts_frame_top` is not directly writable from generated code;
   add a runtime helper `void ts_frame_restore(ts_frame_hdr* t){ g_ts_frame_top = t; }` OR
   expose the extern and assign — prefer the helper for symmetry with
   `ts_gc_set_root_depth`; the handler must then also expose its snapshot, mirror how
   `_h->gc_root_len` is exposed).

## 4. Conversion scope (v1) — what changes and what deliberately does NOT

**Converted in v1** (the overwhelming majority of the 4 M pushes):
- Plain (non-coroutine) generated functions in all three emitter variants:
  - `emit_i64_function` — analyzer/src/emit_c.rs:4627 (reflike root loop :4691-4698,
    `nroot` :4699, unroot :4738-4739)
  - `emit_f64_function` — emit_c.rs:4744 (:4815-4817, :4856-4857)
  - `emit_function` (general) — emit_c.rs:4862 (reflike + roots :5079-5084,
    unroot :5137-5138)
- All abrupt-exit unroot sites driven by `Ctx.nroot` (field decl emit_c.rs:1303; e.g. the
  finally-dispatch `case 1: ts_gc_unroot(n); return` at emit_c.rs:7099-7104).
  Enumerate ALL of them mechanically: `grep -n "ts_gc_unroot" analyzer/src/emit_c.rs`
  (22 sites today) — every site that emits an unroot whose count is the FUNCTION's nroot
  becomes `ts_frame_pop(&F.h)`; sites with constant counts belonging to the exclusions
  below stay untouched.

**NOT converted in v1** (keep old-style `ts_gc_root`; each is a recorded follow-up):
- Startup one-time roots: GLOBALS (emit_c.rs:687), OBJECT_PROTO (:478), CLASS_PROTO
  (:702) — not hot, run once.
- Coroutine-mode functions (async/generator state machines): their try lowering snapshots
  root depth into the coro frame (`_fr->c.eh_gc_depth[_t]`, emit_c.rs:6334-6427) and their
  locals largely live in heap coro frames already. Converting them needs a parallel
  `eh_frame_top[_t]` array — follow-up, only if profiling ever shows coro-heavy workloads.
  The flagship (batch compiler) has no async.
- Adapter `_cv` single roots (emit_c.rs:6690, :6763, :6830, :7444, :9704).
- `ss_base{id}` scalar-slice roots (emit_c.rs:5082) — rare, functions with scalarized
  slices only; keeping them individually rooted is correct alongside a frame (both sets
  are scanned).
- Everything inside runtime/ts_rt.c (operand rooting) — stays `ts_gc_root` by design
  (plan §8.1 decision).

A function whose reflike set is empty gets NO frame at all (no struct, no push/pop) —
this is already the `nroot > 0` condition in the emitter.

## 5. Implementation steps (one commit each, in this exact order)

### S1 — runtime substrate (dead code; zero behavior change)
Implement §3.1 + §3.2 fully (types, global, GC walks, handler snapshot/restore, stats
counter, `ts_frame_restore` helper). Nothing pushes frames yet.
- Verify: full recipe (plan §3.4). Parity untouched by construction (`emitc_diff.sh`
  DIFF=0). `gate gc` green (the empty frame walk is exercised with g_ts_frame_top==NULL).
- Accept: all green; zero measurable wall change on `bench_gc.sh` (rt.o-swap ABAB is VALID
  for S1 — wait, S1 adds ts_rt.h inlines but no caller uses them, so the generated C is
  unchanged and rt.o swap A/B still applies; expect neutral).

### S2 — emitter refactor: centralize local-name formatting (behavior-invariant)
The body emitters format boxed-local references as `v{id}` in ~69 scattered
`format!`/`writeln!` sites (e.g. `Ctx::val` emit_c.rs:1385-1394, `Ctx::numc` :1368-1375,
and the rest — enumerate with `grep -nE 'v\{\}' analyzer/src/emit_c.rs`).
1. Add ONE method on `Ctx`:
   ```rust
   fn vname(&self, id: u32) -> String { format!("v{}", id) }
   ```
2. Replace every boxed-local `v{}` formatting site with `self.vname(id)` /
   `ctx.vname(id)`. Do NOT touch `d{}` (unboxed), `j{}` (json), `ss_base{}`, `_cv`, or
   any non-local identifier.
3. Also centralize the DECLARATION site formatting (the `tsv v{} = TS_UNDEFINED;` loops in
   the three function emitters, e.g. emit_c.rs:4678-4686) behind a helper so S3 can swap
   declarations wholesale.
- **Proof of invariance**: `scripts/emitc_diff.sh` must report byte-identical output
  (DIFF=0, KNOWN unchanged) AND `scripts/gate.sh ir-parity` (export determinism) stays
  green. This is the repo's standard parity-locked refactor. If even one byte differs,
  STOP — you replaced a non-local formatting site by mistake.
- Also run: conformance all + unit (cheap confirmation).

### S3 — emitter frame mode behind a flag (default OFF)
Add an emitter-level switch `TSAOT_FRAME_ROOTS=1` (read once at emit start, e.g. next to
existing env reads in the analyzer driver; plumb as a bool into the emit context).
When ON, for each of the three function emitters, for functions with `nroot > 0`:
1. **Declarations**: instead of `tsv v{id} = TS_UNDEFINED;` per reflike local, emit
   ```c
   struct { ts_frame_hdr h; tsv v3; tsv v5; /* one member per reflike id, ascending */ } F;
   F.v3 = TS_UNDEFINED; F.v5 = TS_UNDEFINED; /* ... every member, no exceptions */
   ```
   Unboxed (`d{}`)/json (`j{}`) declarations are unchanged. Member order MUST be the same
   ascending-id order the root loop uses today (determinism; parity normalization later).
2. **Names**: `vname` returns `format!("F.v{}", id)` when frame mode is ON and `id` is in
   the reflike set (pass the reflike set into Ctx; ids NOT in the set — e.g. a boxed local
   that is provably dead? — do not exist today: the reflike set IS "all boxed tsv locals",
   so `vname` can switch on the same predicate the decl loop uses. Assert equivalence in
   debug).
3. **Prologue**: replace the `ts_gc_root(&v{id})` loop with ONE line after the existing
   arg-unpack block: `ts_frame_push(&F.h, {nroot});`
4. **Exits**: every `ts_gc_unroot({nroot})` site found in §4 becomes
   `ts_frame_pop(&F.h);` (guarded by the same `nroot > 0`).
5. **Handler restore**: next to the emitted `ts_gc_set_root_depth(...)` at emit_c.rs:7035,
   emit the paired `ts_frame_restore(...)` (see §3.2 item 4) when frame mode is ON.
6. `ss_base` roots (:5082): keep emitting `ts_gc_root(&ss_base{id})` and count them in a
   SEPARATE unroot: emit `ts_gc_unroot({n_ss});` at exits (they are no longer part of
   nroot). Simplest correct split: frame carries reflike locals; ss_base stays on g_roots.
- With the flag OFF (default): output must be **byte-identical** to S2 —
  `emitc_diff.sh` DIFF=0 proves the flag is inert. THIS is what keeps parity green until S5.
- Verify (flag ON, local builds only): compile several fixtures with
  `TSAOT_FRAME_ROOTS=1` and eyeball the generated C for one small and one large function;
  then run the S4 battery.

### S4 — flag-ON verification battery + A/B (no default change yet)
All of the following with `TSAOT_FRAME_ROOTS=1` builds:
1. Conformance all (342/342) typed AND untyped.
2. `gate gc` (O2 + ASan + runtime + GC-stress; threshold=1 stress is the frame-bug net:
   an unpopped or uninitialized frame dies loudly here).
3. Exception battery via `dt`: throw across 1/2/5 converted frames into a catch; throw
   from inside a loop with reflike locals; finally with early return; rethrow; nested try
   in the same function; throw through a converted frame into a CORO catch (coro functions
   are unconverted — the mixed case must work because the handler restore is global,
   §3.2 item 3).
4. Deep recursion (10^4 frames) with reflike locals + forced GC (small threshold env) —
   exercises long frame-list walks in the mark phase.
5. bundler 39/39; selfconf (DIFF=0 vs its own baseline); bench 99/99 within budget.
6. **A/B (full-rebuild protocol — ts_rt.h inlines changed, rt.o swap INVALID, plan §3.2)**:
   flag-OFF build vs flag-ON build on the medium-slice native (plan §P0.1.4 input) and
   `bench_gc.sh`. Record: wall delta, `root_push` (OFF) vs `root_push`+`frame_push` (ON).
   Expected: prologue-origin root_push → ~0 (residual = runtime-internal + exclusions);
   frame_push ≈ function-call count; wall −5…−15% on the medium-slice native.
   (This A/B doubles as the §8.1 "counter split" — the OFF/ON root_push difference IS the
   generated-prologue share.)
- Accept: all green + deterministic counters behave as predicted. If wall improvement < 3%
  on the medium slice, STOP and report before S5 — the parity cost of flipping may not be
  justified yet (user decision).

### S5 — default flip (the parity event; REQUIRES explicit user sign-off)
Flipping the default (or hard-removing the flag) makes every emitted prologue differ from
the frozen twin ⇒ ALL parity fixtures DIFF. Options (user chooses at this point):
  (a) land after P4 parity graduation (zero parity mechanics),
  (b) add a mechanical normalizer to `emitc_diff.sh` (strip `F.` prefixes, frame decl/push/
      pop lines, and re-add old-style root lines is NOT feasible faithfully — normalizer
      realistically means "compare modulo frame syntax", i.e. `sed -E 's/\bF\.v/v/g'` plus
      deleting frame-only lines from the Rust side output before diffing; prototype it on
      3 fixtures and show the user before committing to it),
  (c) full parity re-baseline (record a new frozen-diff baseline; heavyweight).
Also in S5: milestone acceptance (plan §9) — selfhost native completes, output
byte-identical to emit-node, wall vs 595 s recorded. Then remove the flag (single mode) in
a follow-up commit once soak is done, and update this doc + TODO.md.

**Approved 2026-07-30:** frame roots become the production default while
`TSAOT_FRAME_ROOTS=0` remains as an explicit legacy mode. Frozen-emitter byte
parity (`emitc_diff.sh` and the own-IR parity step in `typed_selfhost.sh`) runs
that mode together with `TSAOT_PROP_PIC=0`; default-mode semantics are covered
by conformance, GC/ASan, bundler, benchmark, and self-host milestone gates. This
avoids a syntax normalizer and does not re-baseline the frozen emitter.

## 6. Correctness obligations (each must have a test before S5)

| # | Obligation | Test |
|---|---|---|
| 1 | Frame fully initialized before push; no GC point in between | code inspection + gate gc threshold=1 (uninitialized slot ⇒ mark of garbage tsv ⇒ ZAP/ASan explosion) |
| 2 | Pop on EVERY exit path (returns, abrupt control, finally dispatch) | S4.3 exception battery + `dt` early-return cases; an unbalanced frame makes g_ts_frame_top dangle — gate gc catches on next GC |
| 3 | longjmp restores g_ts_frame_top at every landing | S4.3 items; grep-audit: every `gc_root_len` capture/restore has a paired frame_top capture/restore (`grep -n "gc_root_len\|frame_top" runtime/ts_rt.c analyzer/src/emit_c.rs`) |
| 4 | Mixed converted/unconverted frames unwind correctly | S4.3 coro-catch case |
| 5 | Frame slots visible to BOTH young and full marks | S4.4 deep recursion with forced minor+full |
| 6 | No slot aliasing with ss_base/_cv old-style roots (double-scan is harmless — same value marked twice) | note in code comment; no test needed (marking is idempotent) |
| 7 | Emitted-C determinism (member order = ascending id) | `gate ir-parity` self-identity + emitc_diff flag-off byte-identity |

## 7. Rollback / STOP

- S1–S3 are independently revertible single commits; flag stays OFF so main is unaffected
  throughout.
- STOP conditions (plan §3.7 applies): any ASan/GC-stress hit → revert the offending
  commit, analyze offline (R5 — no guard-patching an un-root-caused crash); any `dt`
  mismatch in the exception battery → STOP (semantic bug, not a perf bug); S4 wall < 3% →
  report to user before S5.
- If S2's 69-site refactor proves too error-prone in practice, the recorded fallback is
  the per-function `#define v{id} F.v{id}` / `#undef` prologue trick (zero body-site
  changes, uglier output); switching to it is a design change — ask the user first.

## 8. Follow-ups recorded (not v1)

- Coroutine-mode function conversion (`eh_frame_top[_t]` parallel array).
- `ss_base` / `_cv` adapter absorption into frames.
- Liveness-shrunk frames (smaller slot sets via live-range analysis) — only with profile
  evidence that frame init cost matters.
- mruby-style auto-protection of fresh allocations for runtime-internal rooting — sized by
  the S4 residual `root_push` count (see plan §8.1).

## 9. Completion record (2026-07-30)

S1–S5 are complete. With the user's explicit approval, frame roots are now enabled by
default; `TSAOT_FRAME_ROOTS=0` retains the old per-local root prologue for diagnosis and
frozen-emitter parity. The frozen parity commands also set `TSAOT_PROP_PIC=0`, because
the frozen emitter predates both optimizations. Production-mode semantics are tested
directly rather than normalized back to the old emitted syntax.

The full-rebuild A/B kept property PIC enabled and changed only frame-root mode:

- Medium compiler slice, 100 interleaved runs: OFF median 20.0 ms, ON median 13.0 ms
  (35% faster; p90 21 ms versus 14 ms).
- Full typed self-host: OFF 510.18 s, ON 330.11 s (35.3% faster). The accepted ON result
  is 44.5% faster than the earlier 595 s milestone baseline.
- OFF, ON, and Node emitter outputs are byte-identical after removing the single trailing
  newline added by the native executable.

Final production-default verification passed: typed conformance 344/344, untyped
conformance 344/344, GC O2 19/19, GC ASan 19/19, runtime ASan and threshold stress,
bundler 39/39, benchmarks 101/101, self-conformance 340 PASS + 1 KNOWN with zero
differences, frozen parity 329 identical + 12 KNOWN with zero differences, `ci_fast`,
and runtime/analyzer unit tests.
