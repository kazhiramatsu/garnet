# garnet Complete Refactoring & World's-Fastest Master Plan (v2: Rust-centric)

## Revision History

- **v2 (2026-07-03, session 315, user decision)**: **Move the development focus back from self-host (analyzer_ts) to Rust (analyzer/)**. typed selfhost was achieved in §313, but since native self-compile is impractical at ~600s, self-host is repurposed as "a metric for measuring performance (flagship benchmark) + a byte-parity oracle during the mechanical refactoring period". v1's P3 (typed production wiring) / P4 (Rust attic graduation, boxed retirement) are reversed and simplified.
- v1 (2026-06-11, session 314): Initial version (self-host-centric).

## Context (why do this)

Over 313 sessions we reached the typed selfhost fixpoint via a faithful port from the Rust oracle. However, emitting the self IR (23.4MB, 538 functions, 66,270 instructions) takes **node 30.8s / Rust 23.7s / native typed ~600s**, making self-host impractical as the development focus or shipping artifact (retracted in v2). Meanwhile, the quality problems that the "byte-parity first" discipline of the porting period sacrificed, along with implementation-independent algorithmic problems and silent bugs, remain:

- **Waste (live)**: huge single files — `exporter.ts` 11,074 lines / `ts_rt.c` 9,877 lines / **`emit_c.rs` ~14,500 lines (now the main implementation, so a first-class split target)**. Stale scripts.
  ※ The duplicate walker, double emitter, generated blob, and `any` 150+ in emitc.ts raised in v1 are now **inside the frozen tree** and their maintenance cost vanishes, so they are out of scope (only compilability is preserved). The junk at the repo root was deleted in s315.
- **Bugs (silent kind)**: 2^53-crossing int loop precision (root cause identified during the TS port; Rust has the same logic: a range-dropping join keeps i64Safe / asserts an i64 value while still unranged), the non-catchable abort in JSON.stringify depth>256, the SIGSEGV on deep JSON.parse input, and selfhost's 64MB stack requirement (root cause is switch→nested If lowering).
- **Performance**: the native 20× gap is the runtime (Map/Set linear scan, GC threshold 64K alloc, root/unroot of every reflike local, malloc per closure call) = **a quality problem of every program garnet generates**. The node/Rust ~25s is an algorithmic problem of re-running whole-program numeric analysis ~70 times = **fix on the Rust side**. Property access is an O(n) linear scan with no shapes/IC.
- ~~**Current discrepancy**: the `./garnet` driver still defaults to `TSAOT_ANALYZER=ts`~~ → **already flipped in s318** (default = rust, typed; the ts/native arms remain). VCS was introduced in s315 (`baseline-s313`).

**Goal**: solve all of the above in phases and, wielding AOT's closed-world nature, make it the world's fastest TypeScript processor along both axes of "execution speed × compilation speed". The primary driver of compilation speed is the Rust implementation.

## Role Assignment (the core of v2)

| Component | Role | Development |
|---|---|---|
| `exporter/` (TS, node) | Frontend TS→IR. The only implementation | **Main development target** (splitting, switch flattening) |
| `analyzer/` (Rust) | IR→C. **Main implementation** | **Unfrozen, development focus** (speedup, silent bug eradication, all P6/P7 optimizations) |
| `analyzer_ts/` (TS) | ① Flagship benchmark (real-program load of 66k instructions) ② byte-parity oracle during the mechanical Rust refactoring period | **Frozen (s313 state)**. Source changes forbidden, no new-feature porting. Only compilability under garnet is maintained |
| `runtime/ts_rt.c` | Shared runtime | Main development target (unchanged) |

## Constraints (user decisions, binding across all phases)

| # | Decision |
|---|---|
| 1 | **Rust is the main implementation** (v2, 2026-07-03). byte-parity is maintained as a regression detector for "Rust's behavior-preserving refactors" → before the first change that intentionally alters Rust's output (P5), extend the oracle (P4a) and graduate. analyzer_ts is not moved to an attic but kept as a **frozen benchmark** |
| 2 | **Compiler speed is a first-class goal on par with execution speed** (Rust self-emit 23.7s → low single-digit seconds, all stages shortened including parallelization of the cc stage) |
| 3 | **Only silent-kind semantic gaps are fixed** (2^53 precision, abort/SIGSEGV kinds). bigint / Array.prototype monkey-patch remain loud reject and explicitly out of scope |
| 4 | **Huge-file splitting is done on exporter.ts / ts_rt.c / emit_c.rs** (the frozen analyzer_ts files are out of scope). The tsaot→garnet rename is also carried out (the cargo bin name is also renamed in P8) |
| 5 | **The self-host constraint becomes passive**: since analyzer_ts is frozen, no new violations arise. The bench gate guards that changes to exporter/analyzer/runtime do not break the compilation/execution of the selfhost bench. The only exception where touching the frozen source is permitted is "a minimal fix to preserve compilability" (output invariance proven by parity) |

## Two-Tier Verification Structure (maintained with roles reversed)

- **Behavior-preserving changes to Rust** (pure moves, analysis caching, worklist-ization) → `emitc_diff.sh` (byte-parity 327/327 against the frozen analyzer_ts) mechanically proves equivalence. **The detector is symmetric, so the same script works as-is even with the oracle's direction reversed**
- **Changes that alter the IR/output C** → V8 diff (conformance 327 + bundler 39 + golden_iter 96 + tsc-subset + selfhost family) for semantics, bench budget for performance
- **Runtime-only changes** (ts_rt.c) → the emitted C is unchanged, so parity is irrelevant. Verified by conformance + unit + GC stress + bench (**can be done even before graduation = the key that lets P2a be pulled forward**)
- **exporter lowering changes** keep parity because both Rust and the frozen TS consume the same IR (the rationale for doing switch flattening before graduation). However, **adding a new IR instruction is limited to after graduation because the frozen TS loud-rejects it as UnknownInst** (P2c does the flattening with existing instructions)

---

## Phase List and Dependencies

```
P0 scaffolding(git done, measure) ─► P1 structural unification(exporter/ts_rt/emit_c, parity lock) ─► P3 Rust default ─► P4 graduation + selfhost bench self-containment ─► P5 silent bug eradication
      │                                                                       (small, pull-forward ok)                                        │
      └─► P2 compiler speedup I(parallelizable) ─────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                        P5 ─► P6 execution perf(hot path) ─► P7 AOT differentiation ─► P8 rename + public bench
```

| Phase | Content | Size estimate |
|---|---|---|
| P0 | Scaffolding (git ✅ / gate unification / remaining inventory / measurement infrastructure / baseline) | 1–2 sessions left |
| P1 | Structural unification: split exporter.ts / ts_rt.c / emit_c.rs (parity lock) | 6–9 |
| P2 | Compiler speedup I: runtime + Rust analysis algorithm + switch flattening + parallel cc | 4–6 |
| P3 | Make the driver default to Rust | 1 |
| P4 | parity graduation: oracle extension → selfhost bench self-containment → gate flip + generated-C slimming | 2–3 |
| P5 | silent bug eradication: 2^53 / depth family / label quirk / loud audit (Rust + runtime) | 2–3 |
| P6 | Execution performance: shapes+PIC / interning / StringBuilder / GC / call ABI | 5–7 |
| P7 | AOT differentiation: full typed ABI / element kinds / init snapshot / PGO / LTO+jump table | 5–8 |
| P8 | tsaot→garnet rename + "world's fastest" public bench verification | 2–3 |

---

## Phase 0: Scaffolding — VCS, gate unification, measurement infrastructure

**Goal**: "if you break it, detect with one command, roll back with one command, measure with one command".

1. ✅ **`git init` + initial commit** (s315: `dc8619f`, tag `baseline-s313`, .gitignore in place). Tag after each phase completion henceforth.
2. **Inventory (remaining)**: root junk, dead escape_ir, and stray .o were deleted in s315. Remaining: move helpers into `scripts/lib/` (mimalloc_flags / regexp_link_flags / mftest→lib/mf.sh — **mftest is load-bearing, sourced by the bundler test**). `run_golden_iter.sh` is not deleted but marked as scheduled for gate incorporation in P4a.
3. **Introduce `scripts/gate.sh`** (a thin dispatcher, existing script behavior unchanged): `gate quick|full|typed|parity|conf|selfconf|bundler|unit|gc|bench|bench-correct|tsc|iter|ir-parity|selfbench|ci`. `gate ir-parity` is a new implementation (byte-compares conformance 330 + bundler 39 + selfhost's batch export — the dedicated gate for the P1 exporter split). `gate selfbench` is the selfhost bench (equivalent to typed_selfhost.sh until self-containment in P4b).
4. **Measurement infrastructure** (the performance-side P0):
   - Expand the bench suite (add suite/engines columns to `benchmarks/manifest.tsv`): classics (richards/deltablue/splay/navier-stokes/crypto in plain TS), **escape-hardened dynamic family** (megamorphic property / proto chain / `obj[k]` / Map/Set churn 10³–10⁶ / JSON 1–50MB round-trip that consume their output so optimization cannot eliminate them), **promote self-compile to a stage-partitioned measurement bench** (JSON parse / devirt / escape+sroa / fixpoints / emit / cc / total — **measured across the 3 implementations: Rust, node, native selfhost**), keep startup.
   - Engine-comparison harness `run_engine_benchmarks.sh <node|bun|deno>` (warmed best-of-N, accumulating result JSON in `build/bench_history/`).
   - Profiling path: `garnet --profile` (-g -fno-omit-frame-pointer) + `scripts/profile_bench.sh` (macOS: xctrace/sample, Linux: perf+flamegraph). **On the Rust side, likewise via `cargo build --profile release-debug` etc.** (essential for P2b hotspot identification).
   - **Runtime statistics counters `TSAOT_RT_STATS=1`** (new ~50-line ifdef): minor/full GC counts, total pause, alloc bytes, handle table size, map_find/find_prop probe-length histogram, ts_call malloc count, concat count/bytes, root push count. The factual basis for all subsequent perf decisions.
5. **Baseline record**: pin all gate results, elapsed times, and all bench numbers in `docs/refactor_baseline.md`.

**Gate**: all existing scripts green (just wrapping them). **Risk**: bundler breakage from the mf move → `gate bundler` before and after.

---

## Phase 1: Structural unification — splitting the 3 big files (parity lock)

**Goal**: bring the main implementation (exporter / emit_c.rs / ts_rt.c) into a responsibility-oriented module structure. Carry out pure moves at the granularity of **1 move = 1 `gate parity`** (do not change emit order, speculative emit, or label side effects by a single character).
v1's 1a/1b (TS-side ir_walk, emitc.ts split, `any` eradication) are **retracted** — do not invest in the frozen tree.

### 1a. exporter.ts split (3–4 sessions)
- Split: `wire.ts` (toWireProgram / surrogate handling / precision-preserving numerics — pure functions) / `builtins_table.ts` / `diagnostics.ts` (the unsupported mechanism) / `lower_expr.ts` / `lower_regexp.ts` (lines 2115–2740, highly cohesive) / `lower_stmt.ts` / `modules_linkage.ts` / `scan_free.ts` (the freeVars fixpoint — **moved as one block**) / `exporter.ts` (the Exporter class = orchestrator, kept in place). Methods are mechanically converted to free functions taking `ex: Exporter` as the first argument. node-only, so no self-host constraint.
- **single/batch unification**: make single "a batch of one element" (eradicating the §304 lib-config-difference TS2550).
- **The dedicated gate `gate ir-parity`** (IR byte-invariant) is the lead + conf + bundler + selfbench.

### 1b. ts_rt.c split — unity build (2–3 sessions, parallelizable at any time)
- 10 parts in `runtime/src/` (rt_gc / rt_value / rt_string / rt_array / rt_scalar / rt_object / rt_json / rt_error_eh / rt_async / rt_fetch, at measured section boundaries). **ts_rt.c becomes a unity build that `#include`s the parts in order** (keeping `cc -O2`'s single-TU inline performance and the way `build/rt.o` is made invariant). Introduce `rt_internal.h` to organize forward declarations, and dedupe duplicate typedefs (ts_class_reg ×3, etc.). The public ABI (ts_rt.h) is invariant; confirm zero symbol diff in `nm build/rt.o`.
- Gate: conf + unit + gc + bundler + bench A/B (neutrality).

### 1c. emit_c.rs split (2–3 sessions, new in v2)
Pure-move the ~14,500 lines into Rust modules at measured section boundaries (only `mod`-ization + mechanical assignment of `pub(crate)` visibility; string_metrics / string_materialization / string_plan are already separate files). Rough split map (line numbers are measured anchors from §309–312):

| New module | Source emit_c.rs lines (approx) | Content |
|---|---|---|
| `emit_c/class_layout.rs` | 1075– | class layout / descriptors / proto setups |
| `emit_c/scalar_slice.rs` | 2533– | scalar string slices |
| `emit_c/infer.rs` | 3334–4862 | NumFact lattice / indirect / param facts / i64/f64 fast |
| `emit_c/coroutine.rs` | 4938– | Flat / flatten_cf / SM resume |
| `emit_c/fused_loops.rs` | around 9246–12515 | fused metric/polymorphic loops + select4 |
| `emit_c/inst.rs` | 13468– | emit_inst dispatch |
| `emit_c/builtins.rs` | 13636– / 14423– | all arms of CallBuiltinStatic / CallBuiltin |
| `emit_c.rs` (kept in place) | head + tail | EmitCtx, cname family, emit_program = driver |

- Duplicate walkers and dead arms found in Rust during the split are **only recorded as findings** (`docs/emit_c_findings.md`) — unification/deletion is deferred to P5 onward, except where behavior-invariance is self-evident.
- Gate: 1 move = 1 `gate parity` (the frozen TS is the detector) + `gate full` at phase end. Also record A/B of `cargo build` time (the split should improve incremental builds).

**Overall P1 risk**: module cycles (make emit_c's EmitCtx a leaf) / bundler breakage from the move (→ `gate bundler` before and after) / destruction of label side effects (→ speculative emit is untouchable until P5).

---

## Phase 2: Compiler speedup I — Rust self-emit 23.7s→≤5s / native selfhost 600s→≤60s (parallelizable with P1)

**Goal**: ① Rust self-emit **23.7s → ≤5s** (algorithm side, the real benefit of the main implementation) ② native selfhost bench **~600s → ≤60s** (runtime side = a metric of generated-code quality) ③ parallelization of the cc stage. Doable before graduation (runtime changes are parity-irrelevant, analysis caching keeps output identical, switch flattening preserves parity via shared IR).

### 2a. Runtime data structures (ts_rt.c only, emitted C invariant)
| Measure | Basis (measured) | Expectation |
|---|---|---|
| **Hash index on ts_map/ts_set** (keep the insertion-order key/val arrays for spec ordering + open-addressing u32 index. Strings reuse the existing hash, numbers use a double-bits mix, objects use the handle id) | `map_find` is a linear scan (ts_rt.c:3242, self-admitted in a comment). Analysis is effectively quadratic over instructions × entries × passes | **5–10×** (dominant term of the selfhost bench) |
| **Hashing of ts_intern_field** | Dynamic intern is O(#fields) memcmp (ts_rt.c:4539) | Large for code that heavily uses dynamic keys |
| **Lazy string hashing** (hash=0 sentinel, computed on first reference) | Eager hash at every generation site. The emitter computes millions of hashes it never uses | 1.2–2× for string-construction code |
| **Dictionary fallback for find_prop** (hash when property count >8) | O(n) scan (ts_rt.c:504). Interim until P6 shapes | Medium |
| **GC threshold review** (young 65,536 **alloc count** → ~1M-equivalent or byte accounting, make the full floor proportional to the live set) | Scans all g_roots every 64K allocs (ts_rt.c:27,188) | Medium–large |
| **Remove malloc from closure calls** (stack buffer when total ≤16 slots) | ts_call does malloc+copy+free per call (ts_rt.c:341–357), ts_call_value double-mallocs due to this-injection | Large for callback-heavy code |

Verification: conf + unit + `run_gc_stress.sh` + bench + RT_STATS before/after diff. **Map's insertion-order iteration is the spec**, so ordering regressions are detected by conformance.

### 2b. Analysis algorithm (**Rust implementation**, identical output C → equivalence proven by parity)
- **flatten cache**: after sroa, build the flat instruction sequence and def/use index per function exactly once (introduce a `FunctionIndex`-equivalent inside emit_c). Currently `infer_numeric_analysis` (emit_c.rs 3334–) / `infer_program_param_facts` (3985–) / `collect_i64_seed_param_facts` / `numeric_value_locs` / the dom/slice family re-run flatten **~70–140 times per function** (isomorphic to the measurement at TS-port time = the algorithm is common to both implementations). Also memoize localClassMap/unboxed classification per-function.
- **worklist-ize the fixpoint**: `infer_program_param_facts`'s 8 blind sweeps → a worklist over the call graph (known after devirt). `infer_i64_fast_funcs`'s outer 8 × inner 8 (whole-program re-analysis ≤64 times) → cache call-site contributions + re-join only the affected propagation. **The converged values should be identical → `gate parity` directly proves equivalence** (for one release, keep an equality assert against the old algorithm alongside in debug builds).
- **Eliminate analysis re-runs at emit time**: turn the per-function infer re-runs in the final emit loop into lookups of the converged analysis.
- The node side's (frozen analyzer_ts) ~25s has the same root cause but is **not fixed** (frozen). Rather, it can serve as a comparison axis as the "baseline implementation before algorithmic improvement".
- Expectation: whole-program analysis ~70 times → 2–3 times + a small worklist = **5–10×**.

### 2c. switch-lowering flattening (exporter — the IR changes but parity is preserved via Rust/frozen-TS sharing)
- `buildMatch`'s (exporter.ts:9028–9071) "If chain nested as deep as the case count + an active flag scanning all cases" → **a flat sibling series of If in a run-once breakable Loop** (matched=i; Break). **Composed only of existing IR instructions** (a first-class `Switch` instruction is considered in post-graduation P7 because the frozen TS rejects it as UnknownInst).
- Solves 3 problems at once: ① IR nesting ~300 deep (**the root cause of the 64MB stack requirement and the JSON depth problem**) → O(1) depth, ② the generated C's O(cases) sequential-compare dispatch, ③ the prerequisite for the P7 jump table (pattern detection from the flat form).
- Verification: conf + parity (both implementations at 327/327 with the new IR) + selfbench (**measured removal of `ulimit -s 65520`**) + bundler + bench-correct (watching the control_switch family). Add a deeply-nested switch fixture to prevent regression.

### 2d. Parallel C backend + output construction (Rust)
- `--jobs N`: split-emit the function set into N .c files + a shared header → parallel cc + link (the cc of the 5.6MB single TU is the serial tail. **~4–6×**, the foundation for future incremental recompilation). **The default remains a single .c as before → no parity impact** (--jobs is opt-in).
- Output construction comes after measuring concat cost with the P0 counters (on the Rust side, only low-risk improvements like String pre-reserve may go ahead first).
- Binary-izing the JSON IR is **deferred with a measurement gate** (only if it accounts for >10% in the P0 stage measurement).

---

## Phase 3: Make the driver default to Rust (1 session, can be pulled forward to right after P0)

1. ~~**Flip the default**~~ **Done (s318)**: flip `TSAOT_ANALYZER`'s default from `ts` → `rust` (typed fast path is the default, ill-typed loud-stops, `--untyped` escape). The `ts` / `native` arms remain for oracle/bench use (ts stays boxed+UNTYPED-forced = preserving the frozen-era behavior). The 3-mode smoke + the default-dependent profile_bench.sh become a rust-typed profile, matching the intent.
2. Unify harness paths: move run_conformance / mf to "via the driver + TSAOT_ANALYZER switching" (staged elimination of direct Rust pointing; oracle comparison explicitly points to ts).
3. Update the default description in README / HANDOFF. **ill-typed input now loud-stops with a type error by default** (the previous ts default let it through as boxed) → document the `--untyped` escape.

**Gate**: conf/bundler (via rust) + selfbench + bench-correct.

---

## Phase 4: parity graduation — oracle extension → selfhost bench self-containment → flip

**Strict order: 4a (oracle extension) → 4c (flip)**. Widen the detection net before losing the ultra-high-sensitivity detector that is parity. Rust is not retired (main implementation). analyzer_ts is not retired either (frozen bench).

### 4a. Oracle extension
- Re-wire `run_golden_iter.sh` (96 fixtures) to go through the driver and make `gate iter` permanent. Promote `run_tsc_conformance.sh` to a pass-list gate.
- **Add the known-fail fixtures first** that trip the bugs fixed in P5 (2^53-crossing +/-, huge switch, deep JSON, deep recursive stringify).

### 4b. Self-containment of the selfhost bench (independent of Rust evolution)
- Make **both the input and the reference output re-derivable from the frozen source**: input IR = batch export of the frozen analyzer_ts source (record the content hash; drift from exporter evolution is "detected and intentionally re-pinned"). Reference C = `node analyzer_ts/dist/main.js <pinned IR> emitc` (the output of the frozen logic; dist is rebuildable from the frozen source with tsc).
- **Gate definition (the permanent generalization of diffall/fixpoint)**: the native tsan produced by compiling the frozen source with current garnet (Rust + current runtime) must, for the pinned IR, emit output that **byte-matches the reference C**. The frozen source's behavior is invariant because its source is invariant → this gate keeps verifying "can the current compiler correctly compile a 66k-instruction real program" independently of Rust's evolution and runtime ABI changes (P6 ABI changes are also automatically tracked and verified by rebuilding the bench).
- **Bench definition**: ① compile-speed: the per-stage time for garnet to compile the frozen analyzer_ts ② run-speed: the time for that native to emit the pinned IR (with node 30.8s / Rust 23.7s noted as fixed reference values) ③ correctness: the byte-match above.
- The typed fixpoint (gen2==gen3) is made permanent by being subsumed into selfbench's correctness.

### 4c. Gate flip
- Right before starting P5 (intentional change of Rust output), **run and record the final parity proof** (`docs/parity_final.md` + git tag `parity-final`).
- Remove from CI-required: emitc_diff.sh / devirt/escape dump comparison / 3-way smoke / Rust-vs-TS fixpoint. The truth henceforth is the V8-diff family (expanded conformance tier / bundler / iter / tsc-subset) + selfbench + bench + unit/gc.
- The analyzer_ts tree, boxed emit.ts, and gate scripts are **kept frozen** (neither deleted nor moved to an attic = the re-derivation basis for selfbench. Zero maintenance cost).

### 4d. Generated-C slimming (Rust side; output changes, so post-graduation)
- **Move `ts_setup_global_object` into the runtime**: move the static section (~16KB) that Rust emits into every program into a normal function in ts_rt.c, reducing the generated C to a single call line (cc shortening + generated-C shrinkage). **Only add new symbols; do not change the meaning of existing symbols** (the old-format C emitted by the frozen emitter must remain compilable = selfbench is the detector). Beware the known initialization-order trap (boxing after g_function_proto).
- The frozen-side counterpart (the static blob in emitc_sections_gen.ts) is harmless to leave alone since it is frozen.

---

## Phase 5: silent bug eradication (post-graduation — output C changes. Implemented in Rust + runtime)

### 5a. 2^53 int-specialization precision (highest priority, numeric inference in emit_c.rs)
- **Two-tier the lattice**: separate `i64Safe` (**proven** within ±2^53) from `intValued` (integer but magnitude unproven). ① **demote** i64Safe on a join's range drop and on i64-valuation, ② the unguarded `d+d` fast path is i64Safe only, ③ `intValued`'s +/- is **classified as unboxed double** (= exactly V8's double rounding = correct; no boxing, so small regression).
- **Recovery measure**: loop-bound induction proof (`infer_loop_bounds`) — if in `i < n`, n is i64Safe, i is non-decreasing, and the step upper bound is known, prove `i ≤ n+step` and keep i64Safe → all `for (i=0; i<arr.length; i++)` forms stay int.
- Guarded i64 (overflow branch) is carried over to P6/P7 as an opt-in when [2^53,2^63) is provable (including a design to avoid the `(long long)` UB above 2^63).
- Verification: the 4a known-fail fixtures move to V8 agreement + conf/bench all green + regression measurement of the int→f64 demotion.

### 5b. Audit of the depth family and making them catchable
| Location | Current | Fix |
|---|---|---|
| JSON.stringify depth>256 abort (ts_rt.c:5112) | Not catchable | `ts_throw` (RangeError-equivalent) + env-adjustable limit. The main cause already vanished in 2c |
| JSON.parse recursion (5876–) | SIGSEGV on deep input | depth counter + catchable throw |
| selfhost 64MB stack | Confirmed eradicated in 2c | Completely remove the `ulimit` hack (measured by selfbench) |
| Other O(source) nesting in exporter | Audit | grep optional-chain/destructuring depth, apply the 2c approach if needed |

### 5c. Graduate the label-numbering quirk (emit_c.rs)
- The throwaway emit of the loop body (`try_emit_string_metric_loop_body` emit_c.rs:12515 — a double emit on metric-plan mismatch) → replace with a pure shape decision. Consolidate fdre's plan-path fresh-label → single path. Label numbers change but semantics are invariant (confirm self-consistency with conf + selfbench + bundler).

### 5d. Comprehensive loud-reject audit
- grep-audit "silently fall back on shouldn't-happen" and turn them into throw/panic (checklist-ize the §300 lesson; emit_c.rs / sroa.rs / exporter).

---

## Phase 6: Execution performance — runtime hot path

**Targets**: property kernels ≥3× / richards/deltablue ≥0.8×V8 (stretch 1.0×) / closure call ≥2× / gc churn ≥2× / **native selfhost bench a further ~2×+ (≤60s → ≤10s-class)**.

| Measure | Location | Content |
|---|---|---|
| **AOT shapes + per-site PIC** | runtime+emit_c+analysis | Closed-world ⇒ a compile-time shape id + slot table for every object-literal/class site. Props become a dense slot array, and the `ts_object.shape` word is put to its intended use. Per-site `static ts_pic {shape_id, slot}` in the emitted C — a monomorphic hit = compare + indexed load. delete/exotic demote to dictionary mode. Staged rollout via a `g_has_proxies`-style global gate |
| **String interning** | emit_c+runtime | All static strings are compile-time interned (hash + field-key id precomputed). Dynamic keys use a runtime intern table → pointer-equality fast path (synergistic with shapes) |
| **StringBuilder** | runtime+emit_c | `ts_sb` (exponential growth) + extension of the existing fused/metric paths to builder-ize `s += ...` loops and multi-part template literals (also directly hits selfhost's 5.6MB C construction). ropes are explicitly passed over (views+builder suffice) |
| **root batching** | emit_c+runtime | n calls of `ts_gc_root` → **one push of a frame struct** (reflike locals into a contiguous frame struct, static descriptor). EH already uses the root-depth-snapshot scheme, so it composes. Beware consistency with coroutines (locals reside in the frame) |
| **GC: bump nursery + lazy handle** | runtime | per-object calloc → bump alloc in a contiguous 4–32MB nursery. **A handle is allocated only on the first move/promotion** (eliminating the handle-table store and indirection for short-lived objects). minor GC fixes up direct references from remset+roots |
| **closure ABI** | emit_c+runtime | Pass env directly with an `f(env, args, nargs)` signature (also eliminating the copy remaining from P2a). Handle the ripple to call/apply/bind/adapter in one go |
| **arity-specialized direct-call ABI** | emit_c | A typed C signature `tsv f(tsv a0, tsv a1)` for direct calls of known arity (tsv generalization of the i64/f64 clone mechanism) — eliminates args-array materialization + unlocks C inlining |

Verification: V8 diff (property semantics: order/descriptor/proto as the safety net) + the new suite + RT_STATS diff + gc stress + **selfbench correctness (rebuild the frozen source with the current toolchain on every ABI change = field verification of compatibility)**.

---

## Phase 7: AOT differentiation — proof-based optimizations a JIT cannot do (implemented in Rust)

**Targets**: classics geomean ≥1.0× node & bun / numeric arrays ≥1.5×V8 / keep startup ≥10× / **native selfhost run ≤ Rust self-emit ×2** (stretch: on par).

1. **whole-program shape proof → direct slot access**: if you can **prove** a site is monomorphic + the shape is sealed (no dynamic add, no Proxy), omit even the PIC and directly write `obj->slots[k]`. Dynamic features use a global program-facts flag as an escape hatch.
2. **Eliminate the boxed path for fully-typed programs**: function groups with no `any` inflow get native C signatures end to end (tsv only at I/O boundaries). Keep boxed thunks in FN_TABLE. Full generalization of the i64/f64 clone engine.
3. **Array element kinds**: double-only arrays get unboxed `double[]` storage (kind tag + transition on a non-double store). The int32 kind is decided after measurement.
4. **int32 vs i64 measurement task**: compared to V8 SMI (31/32bit), measure "range-proven i64 (no check)" vs "int32 + overflow branch" on the int suite → document in the public story whichever way it comes out (prediction: keep i64 for scalars, consider int32 only for array elements).
5. **module-init snapshot**: run `__module_init` at build time on an instrumented runtime → serialize the resulting heap into static C data (with a handle/proto relocation table). Gated by a purity analysis (absence of I/O/Date/random). Makes startup a structural advantage.
6. **PGO loop**: `garnet --pgo` — counter instrumentation keyed by IR site id (call site / loop trip / PIC polymorphism) → run → reflect into inlining budget, direct-vs-PIC, hot/cold splitting, and `__builtin_expect` on recompile. Also chain `cc -fprofile-use`.
7. **C-level codegen**: `--lto` (-flto -O3), TS_AOT_INLINE audit (the write barrier's remembered-set path is currently a call), **turn 2c's flat form into real C `switch`/computed goto** (introducing a first-class Switch IR is also possible at this point — parity has graduated; the custom-instruction dispatch is the primary beneficiary), and make coroutine resume a computed goto.
8. **direct-threaded async**: if the callee of an await chain is statically known, resume directly without going through the microtask queue. Make the queue a ring buffer.

Each measure is verified individually with an independent flag + the full V8-diff corpus + a dedicated bench.

---

## Phase 8: Rename + "world's fastest" public verification

### 8a. tsaot→garnet rename
| Category | Target | Policy |
|---|---|---|
| User-facing env | TSAOT_CC/UNTYPED/ALLOW_UNSUPPORTED/USE_MIMALLOC/ANALYZER/LDLIBS etc. | Introduce `GARNET_*` + map old names at the driver's start + a one-time deprecation warning |
| runtime getenv knobs | TSAOT_GC_* / TSAOT_JSON_DEPTH etc. | `getenv("GARNET_…") ?: getenv("TSAOT_…")` (at init only, zero hot-path impact) |
| Internal plumbing | TSAOT_NEEDS_*/REGEXP_*/FETCH_* liaison variables, tsaot_prepare_* in scripts | Bulk-replace without aliases |
| **cargo bin** | The `analyzer` bin name `tsaot` | **Rename it** (since it is permanent as the main implementation. Bulk-replace references in scripts, verify with a full gate) |
| Messages | The `"tsaot:"` prefix | `"garnet:"` (grep-audit fixture EXPECT beforehand) |
| **Not renamed** | C symbols `ts_*`/`tsv`/ts_rt.{c,h}, **identifiers inside the frozen analyzer_ts**, docs history | Frozen with explicit note |

Gate: the full suite + whitelist matching of `grep -rn "TSAOT_\|tsaot" --exclude-dir=analyzer_ts` (excluding the frozen tree).

### 8b. Public benchmark narrative
- pinned node/bun/deno, both cold/warm protocols, peak RSS noted, all suites (classics/honest-dynamic/strings/data-structures/JSON/startup/real-programs).
- **Acceptance criteria**: per-suite geomean of classics/numeric/startup/real-programs ≥1.0× vs node **and** bun. **Publish losing rows too, with analysis** (scaling the honest culture of bench_results.md).
- **Flagship real benchmark = selfhost**: ① how many seconds garnet takes to compile its own 66k-instruction analyzer (the frozen selfhost) ② the time for that native to emit the 23.4MB IR vs node 30.8s (fixed baseline). Include in the narrative that "self-hosting capability was demonstrated in §313 and is re-demonstrable at any time from the frozen source" (the fixpoint is continuously verified as selfbench correctness).
- Continuous defense: nightly dashboard (P0's bench_history) + regression bisect playbook.

---

## Success Criteria (KPI)

| Metric | Current (measured) | Target |
|---|---|---|
| Rust self-emit (main implementation's compile speed) | 23.7s | **≤5s** (P2b) |
| garnet self-compile all stages (export+emit+cc, --jobs included) | Not yet measured (fixed in P0) | Determined after P0 measurement (tentative: ≤30s) |
| native selfhost run (flagship metric of generated-code quality) | ~600s + 64MB stack | **≤60s (P2) → ≤10s-class (P6/P7), default 8MB stack** |
| node reference (frozen analyzer_ts on node) | 30.8s | Fixed as a frozen baseline value (comparison axis) |
| conformance/bundler/selfbench | All green | Keep all green across all phases |
| 2^53 / abort/SIGSEGV silent bugs | 4 known families | **0** (V8 agreement or catchable throw) |
| classics geomean | Not yet measured | ≥1.0× node & bun |
| property/dynamic kernels | O(n) linear | ≥3× current, published with V8 comparison |
| startup | 18× | Keep ≥10× |
| Huge files | exporter.ts 11k / ts_rt.c 9.9k / emit_c.rs ~14.5k lines | All 3 split by responsibility (the frozen tree is out of scope) |
| analyzer_ts (frozen bench) | typed-selfhost-achieved state | **Keep selfbench (compile+run+byte-match) green** |

## Risk Register (overall)

| Risk | Mitigation |
|---|---|
| ~~Starting without VCS~~ | **Resolved** (s315: git init + baseline-s313) |
| The frozen analyzer_ts becomes un-compilable/un-runnable due to exporter/emitter/runtime evolution | Make `gate selfbench` mandatory at phase end (detect the moment it breaks). runtime must not change the meaning of existing symbols (additions are allowed) |
| An output change to Rust slips in before parity graduation | The "no output-changing changes" discipline until P5 + keeping parity CI-required |
| Regressing to dual implementation (porting Rust changes "just a little" into analyzer_ts) | **Prohibition made explicit** (frozen. The only exception is a minimal fix to preserve compilability, output invariance proven by parity) |
| Reduced detection power after graduation | Fix the order 4a (corpus extension) → 4c (flip), keep selfbench correctness permanently |
| Convergence difference from worklist-izing the fixpoint | Prove identical output with parity + keep an old-algorithm equality assert alongside in debug builds for one release |
| shapes/PIC breaking property semantics | Staged rollout via a global gate + V8 diff (reinforced order/descriptor/proto fixtures) |
| Move-consistency of the GC overhaul (bump+lazy handle) | RT_STATS + gc_stress + a flag-switched period of coexistence with the old implementation |
| Missing a bench regression | `gate bench-correct` at each phase end, introduce a relative budget (×V8 ratio) |

## Verification Procedure (common phase template)

1. Inner loop: per change unit, `gate parity` (pre-graduation, behavior-preserving Rust changes) / `gate conf` (post-graduation). Runtime-only changes use conf + unit + gc.
2. Batch end: `gate quick` + relevant individual gates (bundler/unit/gc/bench-correct)
3. Phase end: `gate full` + `gate selfbench` + append bench measurements to `docs/refactor_baseline.md` + git tag
4. Record: as before, append progress to the end of `docs/TODO.md` with the session number

## Out of Scope (explicit)

- bigint (keep loud reject, documented in docs/KNOWN_GAPS.md)
- Array.prototype monkey-patch (out of model, same as above)
- De-node-ifying the exporter (eradicating the TS checker dependency) — recorded only as a next-term theme after this plan completes
- **Resuming self-host development** — technically re-considerable if the generated code enters the ~2×-of-Rust range in P6/P7, but not addressed in this plan (selfbench's numbers automatically accumulate the material for that decision)
