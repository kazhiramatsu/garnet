# refactor baseline — P0 pinned values (2026-07-03, session 315)

The reference point for all perf judgments in the refactoring plan (`docs/refactor_master_plan.md` v2).
From here on, append to this file at the end of each phase (do not overwrite).

- Environment: Darwin arm64 (macOS 25.5.0), `cc -O2` (Apple clang), node v25.2.1
- "†" = a reference value from a period when GC stress etc. was running concurrently in the background
  (lesson: benchmark absolute values under machine load are untrustworthy — re-take A/B under identical conditions).
- **Operating policy (user instruction, 2026-07-03)**: jobs at the ~100%-CPU level running for more than a few minutes
  (gc / bench / full / typed / native emit) must not be run unilaterally. Run them in a "measurement window" whose
  time slot has been agreed with the user, and append the results to this file.

## Gate results and elapsed times (as of P0 completion)

| gate | result | elapsed | notes |
|---|---|---|---|
| `gate parity` | **PASS** identical=327 / UNPORTED=0 / DIFF=0 / skip=0 | 28.2s | when using the batch export cache |
| `gate ir-parity snap`+compare | **PASS** 2,095 files self-consistent | 35.9s (compare only ~18s) | demonstrates the determinism of exporter output |
| `gate conf all` | **PASS** 330/330 | not timed | basic 3 + exhaustive 327. export+transpile 330 is 2.7s |
| `gate bundler` | **PASS** 39/39 | not timed | ran to completion in the verification after helper relocation |
| `gate unit` | **PASS** (runtime + analyzer full suite) | 10.7s† | |
| `gate iter` | **PASS** 48 cases | 25.5s† | the plan's "golden_iter 96" is actually **48 cases** measured (a misprint in the plan) |
| `gate gc` | **interrupted (not fully run)** | — | progressed with no FAIL up to the classes_* range, then stopped per the low-load policy. Full run in a measurement window |
| `gate bench` / `gate quick` / `gate full` / `gate typed` | **deferred** | — | low-load policy. Run in a measurement window and append |

## self-compile stage breakdown (flagship benchmark, `scripts/bench_selfcompile.sh`)

Target: the frozen analyzer_ts (selfhost_typed.ts). IR **23,418,729 B** (23.4MB),
generated C **5,593,546 B** (5.59MB). rust vs node emit is **byte-identical** (confirmed by the check bundled with parity).

| stage | best ms | conditions |
|---|---|---|
| export (node, typed) | 1,452† | --runs 1 verification run |
| emit-rust | 24,584† | same as above (consistent with s314's measured 23.7s) |
| emit-node (frozen TS) | 35,338† | same as above (consistent with s314's measured 30.8s) |
| emit-native (garnet-produced tsan) | not measured | s314 measured ~600s + 64MB stack. In a measurement window |
| cc (5.59MB single TU + link) | not measured | In a measurement window (baseline for the P2d --jobs breakdown) |

Re-measurement under zero load (--runs 3, including cc) and per-pass internal breakdown (separate devirt/escape/sroa/
fixpoint, after analyzer instrumentation in P2) will be appended in a measurement window. JSON
accumulates in `build/bench_history/` (verification-run instance: 20260703T070816Z_selfcompile.json).

## Initial observations of runtime statistics (`garnet --rt-stats`)

Even a smoke program (10-element for loop + one console.log):

- `find_prop`: 860 calls, **avg_probe=12.63** (measured O(n) linear scan)
- `intern`: 298 calls, **avg_probe=98.78** (dynamic intern is O(#fields) memcmp)
- alloc 264 times / 27.5KB, handle_cap 65,536 (a 512KB handle table even in the minimal configuration)

→ The factual basis for P2a (hashing of Map/Set, intern, and find_prop; GC threshold; closure malloc removal).
Per-workload statistics (e.g. during selfhost native execution) will be collected when P2a begins.

## GC microbenchmark (`scripts/bench_gc.sh`, whole suite finishes in ~19s)

Zero-load state, runs=3 best, typed (rust analyzer). **This is the baseline for judging GC improvements (P2a/P6).**
Counter metrics (counts, alloc, probe length, malloc count) are deterministic values, hence load-independent.
The A/B for wall/pause is taken by "sharing the generated C + alternately swapping the old/new stats rt.o via `TSAOT_RT_OBJ` (ABAB)"
(this works because changes internal to the GC keep the ABI invariant). The heavy `gate gc` (threshold=1+ASan) is
split by role as correctness-only — speed here, correctness there.

| bench | wall ms | minor | full | pause ms | max pause ms | alloc MB | notes |
|---|---|---|---|---|---|---|---|
| gc_shortlived | 182 | 45 | 0 | 1.11 | 2.23 | 192.0 | the dominant case of nursery collection |
| gc_survivors | 110 | 16 | **13** | 2.50 | **7.36** | 96.0 | frequent full GC = the actual behavior of the full threshold 262,144 |
| gc_mapset_churn | 760 | 0 | 0 | 0 | 0 | ~0 | **map_find avg_probe=2,219.58**. Map entries turn out to be realloc arrays (outside the GC) |
| gc_closures | 222 | 61 | 0 | 1.20 | 3.79 | 352.0 | **env_malloc=4,000,000** (for 4M calls) |
| gc_strings | 1,194 | 6 | 0 | 3.28 | 5.18 | 536.5 | large-grain alloc is on the alloc/copy cost side rather than GC frequency |

Implications of the first observation (P2a's quantitative starting point):
- Map churn's 760ms is almost entirely O(n) linear scan (2,219 probes/call) → a hash index should change the order of magnitude
- closure calls are confirmed by measurement to be 1 call = 1 malloc (4M calls / 222ms) → the effect of stack-buffering can be measured directly
- full GC's max pause 7.4ms (100k live) → a before/after comparison metric for the P6 bump nursery / lazy handle
- result JSON accumulates in `build/bench_history/<UTC>_gc.json` (first instance: 20260703T073141Z_gc.json)

## Engine comparison (`scripts/run_engine_benchmarks.sh`)

- node v25.2.1 (subset verification): string_scan_kernel 131.2ms PASS.
  .js files that lack the kernel protocol (`module.exports={kernel,BENCH_N}`)
  (self-executing script form) are tallied as skipped with NO_KERNEL — not silently omitted.
- Measuring all rows for node / bun / deno will be done and appended in a measurement window.
- Adding the classics / escape-hardened dynamic suites is for the next session onward (P0 remainder).

## Known notes

- The plan's "conformance 327" is the exhaustive-tier count only. The gate is 330 including basic.
- Generated artifacts inside the bundler fixtures and `build/` are already .gitignored (each harness regenerates them).
- `TSAOT_RT_STATS` is compile-time opt-in (`-DTSAOT_RT_STATS` / `garnet --rt-stats`).
  In the default build the macro becomes empty, so hot-path impact is zero (no regression confirmed with conf all 330/330).

## Measurement window 2026-07-03 (session 316)

- **`gate gc` O2 portion: PASS 18/18** (focused conformance, threshold=1, normal O2).
- **`gate gc` ASan portion: cannot run due to an environment blocker** — the libclang_rt ASan of Apple clang 17.0.0 (clang-1700.6.4.2,
  CLT 26.3) **deadlocks at startup** on macOS 26.5.1.
  `AsanInitInternal → InitializeShadowMemory → get_dyld_hdr → _Block_copy → malloc →
  ASan init reentry → waits on its own StaticSpinMutex and sched_yields in a permanent spin` (confirmed with sample).
  It reproduces even with the minimal ASan binary `int main(){return 0;}` = garnet-independent.
  The previous session's "prolonged run in the classes_* range" was really this too (one binary spinning the CPU for 96 minutes).
  **Remediation candidates: update Xcode/CLT, or homebrew gcc (real GCC's libasan)**. Until resolved,
  operate only the O2 portion with `TSAOT_GC_STRESS_ASAN=0 TSAOT_GC_STRESS_RUNTIME_ASAN=0`.
- Operating know-how: long jobs can be confined to E-cores with `taskpolicy -b -p <pid>`, reducing perceived
  load to nearly zero (do not use for wall measurement; correctness-only).
- **`gate bench`: PASS 99/99 (all rows correct + within budget), elapsed 63s** (serial 1 core, nice 10,
  idle machine). The initial estimate of ~10 minutes was excessive — the whole suite is light.
- **`bench_selfcompile.sh --runs 3` (zero load, best-of-3, elapsed 180s) — the confirmed values without †**:
  export **1,344ms** / emit-rust **22,487ms** / emit-node **29,269ms** / **cc 6,343ms (first measurement
  = baseline for the P2d --jobs breakdown)**. IR 23,418,729B / C 5,593,546B / rust vs node parity=identical.
  JSON: build/bench_history/20260703T093859Z_selfcompile.json.
  (versus the P0 verification run's † values: export -7% / emit-rust -9% / emit-node -17% — a concrete example of load's magnitude of effect)
- **`gate full`: FULL PASS, elapsed 767s (12.8 min)** — conf 327/327 PASS, devirt/escape 327
  identical, native build ok, diffall/native-escape 327 identical, fixpoint ok.
- **`gate typed` / emit-native / all engine-comparison rows: deferred to milestone measurement** (user decision:
  running the heavy selfhost benchmarks every time is too burdensome → switch daily measurement to a lightweight set).

### Daily measurement set (allowed every session, ~90s total, all serial 1 core)

| purpose | command | elapsed |
|---|---|---|
| compilation-stage A/B | `scripts/bench_selfcompile.sh --src tests/conformance/exhaustive/classes/extends_same_name_scopes.ts --runs 5` | ~4s |
| GC/runtime | `scripts/bench_gc.sh` | ~19s |
| perf budget regression | `scripts/gate.sh bench` | ~63s |

- Added **`--src <file.ts>` / `--label`** to `bench_selfcompile.sh` (lightweight measurement mode).
  First measurement (extends_same_name_scopes.ts, ~250-line scale, runs=5 best):
  **export 267ms / emit-rust 17ms / emit-node 68ms / cc 134ms**, IR 125,726B / C 103,237B /
  parity identical. For small inputs, process startup dominates, so **judge only by the before/after diff on identical input**.
  No-regression on the default (selfhost input) is already confirmed at runs=1 (IR/C bytes and parity match the previous values).
  Note: some conformance files (e.g. those using replaceAll) hit a type error under the lib settings when exported standalone —
  choose files whose export passes for lightweight input.

### GC benchmark expansion (P0-remaining classics / escape-hardened, same day)

Three new fixtures (V8 diff OK, the suite becomes 8 and the whole run stays ~30s):

| bench | wall ms | minor | full | pause ms | max p ms | alloc MB | notes |
|---|---|---|---|---|---|---|---|
| gc_binarytrees | 116 | 16 | **4** | 1.59 | 3.92 | 111.0 | a Boehm-family classic. The only case besides survivors that hits full GC |
| gc_cycles | 48 | 18 | 0 | 0.83 | 1.23 | 105.6 | collection of closed-cycle garbage (mark/sweep verification against cycles) |
| gc_escape_poly | 151 | 30 | 0 | 1.12 | 2.21 | 128.0 | the lower bound of alloc pressure that escape/SROA cannot eliminate across polymorphic boundaries |

- **Found a real runtime weakness: `gc_scan_refs` uses recursive marking, and on a deep pointer chain
  (a singly-linked list on the order of ~10^5 nodes) it slams into the stack guard and SIGSEGVs**
  (confirmed in the crash report: deep recursion of `gc_alloc → ts_gc_collect → gc_scan_refs`).
  Because V8's GC can handle graphs of arbitrary depth, this is a semantic gap (a loud crash, but needs fixing).
  **Add worklist-ization (iterative marking) to the P2a/P6 task list**. After the fix, promote the deep-chain fixture
  to a benchmark or to conformance.

## Known parity DIFF list (originating from miscompile fixes, monotonic increase permitted)

**Policy (user decision, 2026-07-03/04, binding)**: when a silent miscompile is fixed on the rust side, its emit
permanently diverges from the frozen analyzer_ts (the twin of the same algorithm). **Accept this and manage it in this list**,
and do not touch the frozen source. **Resync is a milestone** (at the point when speed improvements have accumulated and we want to
verify on selfhost whether they "really have an effect", including fixpoint/byte match): choose either a bulk port of the accumulated
fixes or the P4 parity graduation. selfhost's **role as a benchmark is intact** (the speed of compiling the frozen source as
input, and the execution speed of the generated native, remain valid at all times going forward. The fixed garnet compiles the
frozen source more correctly than before).

Current expected values (2026-07-04, after s317 fixes #3/#4, measured): **emitc parity = identical 323 /
DIFF 0 / KNOWN 9**, **selfconf = 332/332 PASS / DIFF 0 / KNOWN 0**.

Why selfconf is all-green (a finding measured in s317): selfconf runs on the **untyped path** (TSAOT_UNTYPED=1),
and because the frozen side does not manifest this path's SROA/stack optimizations, it compiles the
sroa_* regression tests correctly even while holding the twin of a known bug. **On the Rust side, SROA runs
even when untyped, driven by class shape** (the reason the probe reproduced the miscompile while untyped) — an asymmetry in reach.

**Single source of truth = `scripts/frozen_known_diffs.tsv`** (two kinds, scope=parity / selfconf;
selfconf currently 0 rows). Because emitc_diff.sh / analyzer_conformance.sh read this and tally the known diffs
separately as KNOWN, gate parity / quick / full still PASS with DIFF=0. When a new
miscompile fix diverges from the frozen twin, append to the tsv (with a reason). An alarm 20s guard has been added to
selfconf's fixture execution (even if a frozen-side bug takes a hang form, the gate fails in finite time — a defense after
measuring an infinite loop of wild string concatenation in s317).

| program | origin |
|---|---|
| classes/sroa_contained_escape (s316 new) | fix #1: the frozen side stack-allocates the contained-loop alloc as sobj |
| classes/sroa_narrowed_nullable_reads (s316 new) | fixes #2a/2b |
| classes/sroa_try_body_uses (s316 new) | fix #2c (+ the accompanying difference in numeric scalar type, long long↔double) |
| closures/forof_loop_capture | fix #1: site 14 Stack→FrameArena (**difference in annotation comment only**) |
| errors/super_assign_throws | fix #3: the frozen side removes the receiver-unused `new B().write()` alloc (harmless form); the fixed Rust keeps it. The true identity of s316's "needs a one-line investigation" |
| classes/method_early_return | fix #3: same as above (harmless form) |
| private/brand_in_method | fix #3: same as above (harmless form) |
| classes/sroa_noninlinable_callee (s317 new) | the regression test for fix #3 itself (the frozen side emits with the alloc still dropped. selfconf PASSes because it does not manifest on the untyped path) |
| classes/sroa_loop_carried_alias (s317 new) | the regression test for fix #4 itself (a loop back-edge copy-alias slips through the single-pass disqualification net, and the `head = n` store vanishes along with the alloc) |

Fix #3 (s317) = SROA's scan/rewrite asymmetry: for a Direct call that the scan (disqualification net) allows but
rewrite cannot inline (a non-tail-return callee / an optional-omitted call with arity mismatch), you get
"alloc removed + call left behind" = a wild read of a dangling receiver/arg
(hang/garbage value). Because it manifests without needing try, it was latent in both implementations since before s316 #2c. Discovered
because #2c made the harmless edge visible as the parity difference in errors/super_assign_throws.

## Checklist of things to capture in a measurement window

After agreeing on a time slot with the user, run in order under zero load and append:

1. `nice -n 19 scripts/gate.sh gc` (full run, elapsed time)
2. `nice -n 19 scripts/gate.sh bench` (all-rows RESULT/TIME/BUDGET table)
3. `nice -n 19 scripts/bench_selfcompile.sh` (--runs 3, including cc)
4. `nice -n 19 scripts/gate.sh full` → `nice -n 19 scripts/gate.sh typed` (elapsed time)
5. after typed finishes: `scripts/bench_selfcompile.sh --native "$TMPDIR/typed_selfhost/tsan_typed"`
   (single-shot measurement of emit-native = pinning the KPI "~600s" baseline)
6. `scripts/run_engine_benchmarks.sh node` (all rows. bun/deno after installation)
