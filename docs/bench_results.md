# Benchmark-driven development — results & honest analysis

All kernels run the full pipeline: TS -> exporter -> devirt -> escape -> emit C
-> gcc -O2 -> native, linked against ts_rt. AOT time is wall-clock (incl ~1ms
startup); V8 is node, warmed, best-of-5 steady state. All outputs match V8.

| kernel | AOT | V8 (warmed) | verdict |
|---|---|---|---|
| **integer** loop (`%`, `*`, `+`) | **378 ms** | 519 ms | **AOT wins 1.37x** |
| **float** loop (double arithmetic) | 247 ms | 244 ms | **tie** |
| **object** loop (`new Vec` + method/field) | 989 ms | 365 ms | **V8 wins 2.7x** |
| startup / short task | ~1.3 ms | ~22 ms | **AOT wins ~18x** |

## Where AOT wins, ties, loses — and why
- **Integer (win)**: typed int loops are the sweet spot. V8 must keep deopt
  guards and Smi/double checks; we statically prove int-ness and emit native
  `long long` with plain `%`. Matches hand-written int64 C (378 ms).
- **Float (tie)**: TurboFan already keeps hot doubles unboxed in registers, so
  there's little to win on raw FP arithmetic; we match it but don't beat it.
- **Object (lose)**: this is the honest finding. Even after stack-allocating the
  loop-body `new Vec` (down from 2590 ms via heap+GC, to 989 ms), V8 still wins
  2.7x because it **scalar-replaces the object across the method call** (inlines
  `dot()`, promotes `x`/`y` to registers, eliminates the allocation entirely).
  Our codegen still passes the instance through a real function call with `tsv`
  boxing at the boundary and a struct in memory. Beating V8 here needs
  cross-call inlining + SROA (scalar replacement of aggregates), which is exactly
  what V8's optimizer is best at.

## Bugs the benchmarks caught (the point of measuring)
1. **All-boxed values**: first int kernel was 2.5x *slower* than V8 (1320 ms) —
   box/unbox dominated. Fixed with the unboxed numeric path.
2. **Double<->int64 churn**: modulo round-tripped through doubles (862 ms). Fixed
   with integer specialization (least-fixpoint int-typing) -> 378 ms.
3. **Number formatting**: float kernel printed `1.25e+15` vs V8's
   `1250002487503344.2`. Fixed with JS shortest-round-trip formatting.
4. **Heap corruption**: typed class instances were heap-allocated with the base
   `ts_object` size, overflowing into adjacent memory (glibc abort). Fixed with
   `ts_new_sized(sizeof(struct))`.
5. **Devirt missed nested calls**: `v.dot()` inside a loop stayed dynamic
   (returned 0) because `run_devirt` only walked top-level body. Fixed by
   recursing into Loop/If bodies.
6. **Loop allocation strategy**: loop-body NoEscape was heap-allocated; now
   stack-allocated per iteration (C scope gives per-iteration lifetime soundly).

## Takeaways for the speed thesis
- The thesis holds in the regime it claimed: **typed numeric / integer code, and
  startup-bound workloads**, where static type+escape info lets us erase what V8
  must check at runtime.
- It does NOT hold for allocation-heavy OO code unless we add **inlining + scalar
  replacement of aggregates** to compete with V8's optimizer. That's the next
  big lever, not more micro-tuning.
- Float arithmetic is a wash — V8 is already optimal there.

## Next benchmarks / work
- Implement method inlining + SROA for small NoEscape objects (the object-kernel
  gap); re-measure.
- String/array workloads (honest fallback cost on the dynamic path).
- CI harness that compiles+runs all kernels and asserts correctness + a time
  budget, to catch perf regressions automatically.

## Update: object kernel after SROA + method inlining
Implemented scalar replacement of aggregates (SROA) + method/ctor inlining for
NoEscape class instances (analyzer/src/sroa.rs, run after devirt + escape, before
emit). A `new C()` that doesn't escape and is used only as a Direct-call receiver
is eliminated: its fields become scalar locals and the ctor/method bodies are
inlined (this.fK -> field scalar, params -> args, return -> dst).

| object kernel | time | vs V8 (273 ms) |
|---|---|---|
| heap + GC (original) | 2590 ms | 7.1x slower |
| stack struct | 990 ms | 2.7x slower |
| **SROA + inlining** | **~210 ms** | **AOT wins 1.29x** |

The loop body is now pure scalar arithmetic — no AllocObject, no FN_TABLE call,
no tsv boxing — which is exactly what V8 produces via its own escape analysis +
inliner, but we do it statically at AOT time.

Soundness verified: a Box that escapes via `return` is NOT scalar-replaced (keeps
the heap object + real ctor/method calls), while a non-escaping Box in the same
program is fully inlined; both produce correct results. A stale-header bug
(ts_new_sized lacking a prototype, truncating the returned 64-bit value to int)
was caught by this soundness test and fixed.

Verdict update: the speed thesis now holds for typed integer AND allocation-heavy
OO code (when objects are NoEscape), plus startup. Remaining honest gaps: float
is a tie; string/array/dynamic workloads fall back to the tsv path.

## Update: free-function argument SROA
The later typed-field gap was a narrower variant: the object was already not heap
allocated, but `sink(p)` made the fresh `Point` materialize as a stack struct. SROA
now allows Direct free-function arguments when the callee is tiny and uses the
parameter only for declared field loads/stores, and the inliner rewrites those
loads/stores to the caller's field scalars. Current result:
`typed_field_kernel` ~160 ms -> 66-67 ms, faster than the recent V8 baseline
(~94 ms). The remaining allocation-heavy gap is `gc_churn_kernel`, which still
creates short-lived arrays and likely needs fixed array-literal scalarization.

## Update: JSON parse/stringify mixed payloads

Added `json_perf_kernel`, a JSON workload covering class-instance
`JSON.stringify(...).length`, nested object/array stringify length, pretty
stringify length (`space`), and repeated constant `JSON.parse` payloads. Current
measurement:

| JSON kernel | AOT | V8 (warmed) | verdict |
|---|---:|---:|---|
| `json_perf_kernel` | 16 ms | 18 ms | AOT wins 1.1x |

The win comes from AOT-visible JSON work: literal `JSON.parse("...")` is folded
to constants, and `.length` on supported `JSON.stringify(...)` shapes is lowered
to direct length arithmetic instead of materializing the JSON string. The generic
dynamic runtime JSON path still exists for shapes that cannot be proven safely.

Follow-up tightening folds numeric expressions containing constant
`JSON.parse("number")` calls (for example repeated parse-literal sums) and teaches
the numeric analyzer that JSON number/string length helpers return integer
lengths. This shortens the generated hot loop, although the 20k-iteration benchmark
is now close enough to process/global setup overhead that wall-clock changes are
mostly in the 16-18 ms noise band.

## Update: one-code-unit replacement metrics (2026-10-18)

Measured on Apple M5, arm64 macOS (Darwin 25.5), Apple Clang 21, `cc -O2`.
The reference runtime is revision `e2814c9`. Each comparison links the same
generated C against the reference or optimized runtime, warms each executable
once, then alternates AB/BA execution order for 11 runs per executable. Times
below are median process wall times, including startup, measured with Python's
`perf_counter_ns`. Every run checks the expected output.

| workload | allocator | before | after | speedup |
|---|---|---:|---:|---:|
| `string_dynamic_replace_kernel` | default static mimalloc | 266.76 ms | 22.38 ms | **11.92x** |
| `string_dynamic_replace_kernel` | libc | 273.52 ms | 21.68 ms | **12.61x** |
| `string_dynamic_split_join_kernel` | default static mimalloc | 51.41 ms | 51.16 ms | 1.00x |
| `string_unicode_search_kernel` | default static mimalloc | 87.32 ms | 87.27 ms | 1.00x |
| `property_dictionary_kernel` | default static mimalloc | 162.30 ms | 161.80 ms | 1.00x |

The replacement workload cycles through four source strings for 1.5 million
iterations and sums the replacement result's length, first `+` position, and
first code unit. A three-second sampling profile of the same kernel at 20x the
iteration count attributed 2,485 of 2,580 samples (96.3%) to
`ts_str_replace_literal_metric3` and its callees. The old helper visited every
replacement and repeatedly searched each unchanged segment.

Replacing one UTF-16 code unit with one code unit preserves length and indices.
The helper now derives the first matching position from at most two searches
of the source and substitutes the requested character directly. The measured
gain applies to fused `replaceAll` metrics. Substantial work stays in `ts_rt.c`,
following the runtime header policy.

The benchmark output remains `294750000`. Its time budget is now 90 ms, down
from 380 ms. Runtime tests compare 19,456 metric combinations against actual
replacement strings, covering short/empty strings, NUL, Latin-1, BMP characters,
surrogate halves, out-of-range indices, and single versus global replacement.
The additional conformance fixture checks V8 agreement, including sliced strings
and generic fallbacks for empty/multi-unit patterns and `$` replacement tokens.

Run the existing performance and correctness gate with the production allocator:

```bash
TSAOT_USE_MIMALLOC=1 TSAOT_RUNS=5 bash scripts/run_benchmarks.sh
```

Raw measurements, build scripts, and logs for this run are retained locally
under `build/perf_20261018/` (`comparison.json`, `comparison.log`,
`baseline.log`, and `optimized.log`).

Validation passed: all 101 benchmarks with static mimalloc, the complete
bounded parallel CI, exhaustive conformance (372/372), basic conformance (3/3),
bundler tests (40/40), runtime/Rust unit suites, and normal/ASan GC stress
including the 64 MiB string-builder scale gate.

## Update: TypeScript 6.0.3 source analysis (2026-10-18)

Input: Microsoft/TypeScript **6.0.3**, commit
`050880ce59e30b356b686bd3144efe24f875ebc8`, copied into
`build/typescript_603/source/` using git archive. The original checkout is
unchanged. Dependencies were installed with `npm ci --ignore-scripts`.

The upstream compiler was built successfully using its LKG bootstrap:
`node node_modules/hereby/bin/hereby.js local --lkg` (**6.764 s**). A subsequent
Node self-build, `node built/local/tsc.js -b src/typescript src/tsc --force
--extendedDiagnostics`, took **6.188 s** wall, including **4.14 s** checking.
Its CPU profile attributed about **53.7%** of exclusive samples to checker code.
These are Node measurements of the upstream build.

Garnet now exports the tsc source graph through the public --project option
with its normal diagnostic gate, resolving the original **807** unsupported
sites. Use the compiler project options because the tsc subproject normally
consumes referenced declarations and excludes the Node ambient types:

```bash
# From the isolated TypeScript source directory; GARNET_ROOT is the Garnet repo.
node "$GARNET_ROOT/exporter/exporter.js" \
  --project src/compiler/tsconfig.json src/tsc/tsc.ts \
  ../complete.program.json ../complete.labels.json

# From the Garnet repo; phase records go to stderr.
TSAOT_PHASE_TIMINGS=1 analyzer/target/release/tsaot \
  build/typescript_603/complete.program.json emit > build/typescript_603/tsc.c
```

Source export took **10.791 s**, peak RSS **2.30 GB**. The accepted graph contains
13,075 functions and produces approximately **69 MiB** of C. Initial sampling
found global-set field reachability scanning the whole field table for each
object. After restricting traversal to the owner's BTreeMap range, a second
profile identified repeated numeric-inference sweeps over unrelated initializers.
Numeric inference now revisits dependent definitions while preserving the
original sweep order and fact lattice.

The table compares release Rust analyzers on the same accepted IR. Three runs
per variant were alternated AB/BA/AB, after other builds/tests had finished.
Times include process startup, JSON parsing, analysis and C emission to
`/dev/null`. No forced-GC settings were used. Generated C was also captured and
verified byte-identical across both changes.

| analyzer | median wall | median CPU | speedup |
|---|---:|---:|---:|
| before reachability/numeric scheduling fixes | 26.070 s | 26.020 s | 1.00x |
| after both fixes | **4.264 s** | **4.246 s** | **6.11x** |

A validation native build using `cc -O0` linked in **42.693 s** with peak RSS
**7.26 GB**, producing a **99 MiB** executable. The `cc -O2` attempt was stopped
after **485 s**; a Clang sample was dominated by LLVM JumpThreading/LazyValueInfo.
Running the executable with --version fails during host startup because Garnet
does not provide the Node process/require/fs host and TypeScript's sys remains
undefined. Native self-compilation and native compiler runtime performance are
still unverified. The speedup above measures Garnet's analyzer/C generator.

Validation: full V8 conformance **392/392**, bundler **41/41**, Rust/runtime unit
suites, ordinary CI and all benchmark outputs passed. The frozen analyzer stays
unchanged; explicitly recorded gaps yield typed parity **355 identical + 34
KNOWN** and self-conformance **382 PASS + 7 KNOWN**. Heavy forced-GC gates are
now opt-in with `TSAOT_CI_GC_STRESS=1`. Raw logs and profiles are retained in
`build/typescript_603/`, including `analyzer_comparison.json` and `profiles/`.

### Further pipeline optimization

The next comparison uses the previous session's optimized analyzer/frontend as
its baseline, with the same pinned TypeScript source and accepted IR. Each
variant runs three times in AB/BA/AB order, after Garnet's other builds/tests
have finished. Rust emission writes to /dev/null; frontend runs write their
normal JSON artifacts. No forced-GC settings are used.

| phase / metric | previous | current | improvement |
|---|---:|---:|---:|
| analyzer/C emission, median wall | 4.197 s | **2.361 s** | **1.78x** |
| analyzer/C emission, median CPU | 4.172 s | **2.355 s** | 1.77x |
| frontend, median wall | 10.433 s | 9.928 s | 1.05x |
| frontend, median peak RSS | 2.298 GB | **2.183 GB** | **5.0% lower** |

The analyzer reuses ordered bitsets for pending numeric instructions, skips
callers that cannot contribute numeric parameter facts, and indexes function
IDs once for the four ABI metadata tables. Sparse/reserved IDs retain their
existing entries. The frontend combines wire conversion and UTF-16 validation
in one traversal, copying only changed ancestors instead of duplicating every
IR node. Constants, property names and field names keep their existing UTF-16
wire representation; the original IR is never mutated.

All analyzer pairs completed before an unrelated background build started.
That build overlapped the later frontend pairs, so the frontend wall-time gain
is indicative. Per-run frontend RSS consistently fell from 2.293–2.301 GB to
2.183–2.186 GB. Individual observations, process CPU times and peak RSS are in
`build/typescript_603/opt_next/comparison.json`.

The complete TypeScript IR, labels and generated C match the baseline byte for
byte. Validation passed: V8 conformance **392/392**, bundler **41/41**, ordinary
CI, Rust unit tests **21/21**, UTF-16 wire conversion tests, typed frozen parity
**355 identical + 34 KNOWN**, and all **101** benchmark correctness/time budgets
with three runs and static mimalloc. The native compiler/Node-host limitations
described above still apply; this measures source export and IR-to-C generation.

## Update: Running the generated TypeScript 6.0.3 compiler

The native-host limitation in the preceding historical sections is resolved.
The generated compiler now executes the upstream command line with a synchronous
C `System` host. It checks and emits the complete upstream compiler project;
all 78 emitted files are byte-identical to the Node compiler's output. A
deliberate TS2322 error and positive interface, optional-method and enum cases
also match Node's diagnostics and exit status. There is no Node/V8 fallback in
the native executable. Library declaration files remain external data.

The first complete, correct comparison used three alternating runs after warmup:

| executable | median wall |
|---|---:|
| Node 25.2.1, upstream TypeScript 6.0.3 | 3.380 s |
| Generated native compiler, correctness baseline | 41.095 s |

These times include process startup, source loading, checking and emission. They
exclude Garnet export, Rust analysis and C compilation. Both executables use
the same project and options, with incremental/composite/declaration/source-map
output disabled. The native runtime is AppleClang O2 with static mimalloc;
generated C is O1 except eight large initialization/factory functions at O0.
That C build took 296.965 s. Normal automatic GC remains enabled, without
forced collections or threshold changes. This result establishes correctness,
and does not claim a speed advantage over Node or tsgo.

Reproduction commands, mixed-optimization details and validation are in
`benchmarks/typescript_native/README.md`. The runner records output hashes,
per-process CPU time and peak RSS, and rejects any mismatch before publishing a
speedup. Raw baseline records are under
`build/typescript_603/native_host/nullish_full_bench/`.

### Final three-way emit comparison

All three executables passed negative/positive diagnostics and emitted the same
78 output files on warmup and every timed run. After Garnet's builds/tests
finished, three timed runs alternated order across Node, the saved native
baseline and the accepted native executable. Both native versions use the same
clean C host. No forced-GC settings were used.

| executable | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Node 25.2.1 | 3.435 s | 6.277 s | 0.800 GB |
| Saved native correctness baseline | 41.581 s | 41.409 s | 2.181 GB |
| Accepted native changes | **35.655 s** | **35.531 s** | **1.923 GB** |

The native improvement is **1.166x**, or **14.3% less wall time**, with roughly
12% lower peak RSS. This combines property caches, closure merge buffers,
exception helpers and allocator build settings; it is not attributed to caches
alone. Node remains approximately **10.4x faster**. Generated C stays at O1 with
the same eight O0 factory/initialization exceptions, while the runtime uses O2.

Native sample ranges were 41.413–41.847 s for the baseline and 35.280–35.819 s
for the accepted executable. Node ranged 3.422–3.476 s. An unrelated background
workload was present; the alternating comparison and CPU/RSS records expose
that practical variability rather than claiming controlled laboratory timing.
Raw samples and output validation are in
`build/typescript_603/native_host/adaptive_full_bench/run-mv_wtso5/result.json`.

### Runtime changes and remaining C bottlenecks

The accepted implementation keeps the existing 52-byte inline shape cache.
Unsized receivers, including dictionary objects, validate an own slot directly
against the live key and bounds. Only sized receivers use an auxiliary location
table (4,096 buckets, 576 KiB). Interface method lookup also uses caches.
Missing optional properties no longer exhaust the failure budget. See
`property_pic_design.md` for guards and invalidation.

Two rejected candidates expanded every site to 136 bytes. Inlining all location
guards also expanded native `__TEXT` to 95.14 MB. Both regressed the full compiler
while reducing searches. The accepted executable uses 58.23 MB of `__TEXT` and
keeps the original ordinary inline guard sequence. The baseline already had
shape caches; this is not evidence that disabling all caches is faster.

Additional measured runtime changes use a separate 64-slot stack buffer for
medium captured environments, omit Darwin signal-mask save/restore for JS
exceptions, and compile vendored mimalloc in release mode. O2 alone had left the
allocator's upstream MI_DEBUG=2 checks enabled. Runtime assertions remain active.
`TSAOT_PRESERVE_SIGNAL_MASK=1` and `TSAOT_MIMALLOC_DEBUG=1` retain those diagnostic
behaviors when needed. The generated C build took 314.050 s, peak RSS 15.684 GB.

The following counters compare successful check-only runs of the same compiler
project. Profiling binaries instrument the runtime, while generated inline code
remains uninstrumented: do not interpret their partial PIC counters as the whole
program's hit rate. Baseline and optimized runs have exactly the same managed
allocation count/bytes and normal automatic collection counts.

| runtime counter | saved correctness baseline | accepted changes |
|---|---:|---:|
| `find_prop` calls | 657,666,832 | 279,195,419 |
| closure argument merge heap allocations | 21,585,091 | 1,294,219 |
| class-registry lookups | 477,224,196 | 11,598,322 |
| managed allocations | 121,969,010 | 121,969,010 |
| managed bytes allocated | 10,668,565,681 | 10,668,565,681 |
| automatic minor/full collections | 2,725 / 5 | 2,725 / 5 |

An opt-in PC sampler identified repeated signal-mask operations in the rejected
candidate; the accepted no-mask helper avoids them. The final check-only profile
recorded **9.060 s** of automatic GC pauses over a **32.322 s** instrumented run.
Its PC samples cluster in GC tracing (`gc_mark_visit`, `gc_scan_cell`) and
allocator free-list growth (`mi_page_free_list_extend`). Samples also frequently
land at the system `madvise` return stub. Asynchronous signal delivery can bias
samples toward syscall boundaries, so those counts must not be interpreted as
precise syscall CPU-time shares. Allocation/GC traffic remains a major
limitation: property cache hits do not remove it. Check-only profiling times
are not substituted for the validated emit benchmark.

Raw counters, PC summaries, compiler flags and build exceptions are retained in
`build/typescript_603/native_host/`, notably `adaptive_profile.stderr`,
`adaptive_correct_profile_summary.json`, `adaptive_profile_system_summary.json`
and `adaptive_build.json`. Rejected candidates remain separate artifacts.

The 32-layout interface kernel used 15 alternating repetitions. With identical
C emission, the old debug allocator and signal-mask preservation on both sides,
median wall time was 48.504 ms before and 48.139 ms after the cache/dispatch
changes. The complete production runtime measured 47.376 ms. This is essentially flat
in this small-object case, despite 7,999,996 hits in 8,000,000 reads and 1,999,999 hits in
2,000,128 writes. Steady-state property searches disappear, but checks and
indirect calls remain. The kernel uses no auxiliary location-table probes:
small unsized objects use the compact live-slot check. All variants print the
same `62572000000`; raw repetitions are in `interface_comparison.json`.

A follow-up caught a cache-policy regression hidden by the loose time budgets:
replacing a shape merely because its slot matched another receiver collapsed
four stable shapes into fewer inline entries. The final policy retains all four
warm shapes, preserves them on dictionary hits, and samples promotion of unseen
shapes after warmup. A direct runtime regression checks all four inline hits.
The four-shape kernel recovered from 145 to 90 ms; the dictionary kernel was
89 ms. All **102** benchmark outputs and time budgets passed with three runs,
alongside conformance **403/403**, bundler **42/42**, Rust **21/21**, CI-FAST,
frozen parity **323 identical + 77 KNOWN**, and frozen self-conformance
**391 PASS + 9 KNOWN**, with no unexplained differences. No forced-GC stress was
run. Frozen analyzer source stayed unchanged.

A separate one-slot initial-capacity experiment for the internal `__value`
property also passed full compiler output/diagnostic validation, but measured
35.203 s versus the accepted version's 35.280–35.819 s with essentially unchanged
peak RSS. This did not establish a meaningful gain, so that heuristic was not
adopted. Raw trial data remains under `cell_capacity_bench/`.


### GC and property-buffer allocation (Session 349)

The next optimization uses the accepted Session 348 executable as its saved
baseline, with the same generated C object, host, compiler flags and release
mimalloc. Array/Map dirty spans restrict a minor collection to recently written
64-entry cards. The spans retain their aging credits; promotion, generic writes,
reordering, compaction and oversized indices retain a complete-scan fallback.
Young containers and full collections still scan every element. On arm64 the
metadata fits existing padding: arrays remain 128 bytes and maps 144 bytes.
An inline old-generation filter also avoids entering the outlined mark worker
for an edge that the minor collector will not follow.

Four-slot property buffers use a bounded free list, preserving the original
capacity policy and property flags. Of 78,188,465 initial-buffer requests in the
check-only workload, **77,110,131** reuse an existing buffer and **1,078,334**
require malloc. This avoids about 7.40 GB of cumulative allocation requests;
it does not mean 7.40 GB less resident memory. The free list retains at most
65,536 buffers, or **6 MiB**. Larger property buffers use the normal allocator.

Paired runtime-statistics runs of the compiler project with `--noEmit` show:

| counter | saved runtime | accepted runtime |
|---|---:|---:|
| Minor / full collections | 2,725 / 5 | 2,725 / 5 |
| Managed cells allocated | 121,969,010 | 121,969,010 |
| Managed cell bytes allocated | 10,668,565,681 | 10,668,565,681 |
| Array elements inspected by minor GC | 763,812,839 | 139,986,858 |
| Map keys/values inspected by minor GC | 264,718,866 | 7,073,210 |
| Mark-edge visits, all collections | 1,262,357,194 | 380,885,557 |
| Cumulative GC pause time | 8.570 s | 2.881 s |

Collection counts, aging outcomes, live cell bytes and visited cell counts by
kind match. The collector does less repeated scanning; collection thresholds,
root lifetimes and collection frequency are unchanged. Instrumentation compiles
out of the production executable. Runtime-only profiling does not count all
inline generated-C frame/PIC operations, so those counters are incomplete.
Raw summaries are `logs/gc_final_{baseline,optimized}_profile.stderr` under
`build/typescript_603`.

A closure/environment coallocation experiment was excluded. It eliminated a
separate buffer but increased managed cell bytes from 10.669 to 13.675 GB and
minor collections from 2,725 to 3,412, without a convincing isolated speed gain.
The accepted runtime retains the original closure representation. Most of the
GC improvement comes from avoiding repeated old-container scans; allocation
request reductions should not be confused with equivalent wall-time gains.

Validation: **404/404** normal V8 conformance, **102/102** benchmark correctness
and budgets with three runs, CI-FAST, and runtime units with both libc and static
release mimalloc pass. Bundler **42/42** passes with libc; the existing bundler
harness omits explicit mimalloc link libraries, so its explicit-mimalloc attempt
failed to link and is not counted as a passing test. Added regressions use
ordinary allocation pressure for closure captures, old-array mutations, Map
compaction/clear, generic properties and the dirty-card range boundary. No GC
stress or threshold overrides were used. The frozen analyzer remains unchanged.

The final full-emission comparison alternated three timed launches after warmup,
after all Garnet builds/tests finished. Every launch matched stdout, diagnostics,
exit status and the SHA-256 manifest of all **78 emitted files**.

| executable | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Node 25.2.1 / V8 | 4.622 s | 7.698 s | 0.797 GB |
| Saved Session 348 native | 46.201 s | 42.778 s | 1.941 GB |
| Accepted GC/allocation changes | 33.942 s | 31.688 s | 1.941 GB |

This run shows **26.5% less wall time** and **25.9% less process CPU time**
for the native pair. Peak RSS is effectively unchanged; this is a reduction in
scanning and allocator traffic, not a lower live-object footprint. Native remains
approximately **7.3x slower than V8**. These figures use the same generated
O1 object with eight O0 exceptions, O2 runtime and static release mimalloc.

An unrelated TypeScript benchmark used roughly four CPU cores during these
runs. Native baseline samples ranged 41.573–48.657 s and accepted samples
33.315–35.486 s. Do not compare this loaded run's absolute times directly
to earlier quiet measurements. The alternating comparison includes both wall
and process CPU time. Its complete record is
`build/typescript_603/native_host/gc_opt/final_emit_bench/run-01s9edcy/result.json`;
source/object/binary hashes and layout checks are in `gc_opt/build.json`.

### Lazy prototypes and cached property additions (Session 350)

A 28-second `sample` of the Session 349 executable (8,193 stacks) put 57.5%
of self time in generated code. In the runtime, closure calls (`ts_call`,
6.3%), collection work (10.4%), property loads/stores (8.3%) and the eager
per-closure prototype setup (`ts_set_fn_prototype`, `ts_intern_field` for
`"constructor"`, `ts_define_data`) stood out. Counters from the check-only
profile explained two of them: 31,000,213 closures each received a prototype
object and a `constructor` property, and 73,092,259 fixed-key stores hit the
store cache only 1,822,472 times because they added properties to fresh
objects.

Two runtime changes address this without touching generated code. The
`constructor` property of a fresh prototype is defined on first observation,
and `ts_set_pic` consults a bounded property-addition cache keyed by site and
pre-addition shape (invalidated by accessor definitions, prototype relinks,
class registrations and every collection). `ts_strict_eq` also short-circuits
identical bit patterns.

Relinking the saved Session 349 compiler object against the new runtime and
alternating three timed launches after warmup (every launch matched stdout,
diagnostics, exit status and the SHA-256 manifest of all 78 emitted files):

| executable | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Node 25.2.1 / V8 | 3.621 s | 10.2 s | 0.80 GB |
| Session 349 native (`gc_opt/tsc-final`) | 28.536 s | 28.5 s | 1.93 GB |
| Relinked runtime (`gc_opt/tsc-s350`) | **26.415 s** | **26.3 s** | 1.92 GB |

That is **7.4% less wall time** for the native pair. The machine was lighter
than during the Session 349 table (its baseline measured 33.9 s then), so only
the paired comparison is meaningful. Raw samples are in the session scratch
record copied to `build/typescript_603/native_host/gc_opt/s350_relink_bench/`.

The emitter now spells function prototypes as `ts_set_fn_prototype_lazy(fn)`,
which removes the prototype object allocation itself. On a checker-style
probe (six nested declarations per call, 4M calls, a few escaping closures)
the lazy emission ran in 1.24 s versus 1.53 s for the eager spelling with
the same runtime.

The compiler C was then regenerated with the production emitter
(`scripts/build_typescript_native.sh`, O1 with the same eight O0 exceptions,
O2 runtime, static release mimalloc; 305 s). Modulo the 13,594 prototype
sites the C is line-identical to the Session 348 object source, so the pair
below isolates the lazy prototypes. Three alternating runs after warmup, all
outputs and diagnostics matching Node on every launch:

| executable | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Node 25.2.1 / V8 | 3.298 s | 9.2 s | 0.80 GB |
| Relinked old C (`gc_opt/tsc-s350`) | 24.350 s | 24.3 s | 1.92 GB |
| Regenerated lazy-prototype C (`native_s350/tsc-native`) | **23.872 s** | **23.7 s** | 2.02 GB |

That is a further **2.0% less wall time**. Check-only statistics explain the
size of the step: managed cells fall 119.7M → 92.3M (−1.97 GB), minors
2,675 → 2,153, pauses 2.14 → 1.82 s and `"constructor"` interning 32.2M →
3.4M calls, but the removed allocations were cheap bump allocations whose
expensive companions (interning, `constructor` definition, property buffer)
had already gone with the runtime change. Peak RSS rises by about 70–100 MB
in emit mode only (check-only is flat at 1.43 GB): with 27% fewer young cell
bytes per unit of work, minors run less often and the malloc'd payloads of
dead young strings and environments are released later. A payload-aware
minor trigger is the natural follow-up. Native remains about 7.2x slower
than V8 on this machine state. Raw records: `native_s350/results/`.

### Typed cells (Session 350, slice C5a)

Captured variables now live in instances of the synthetic class `__cell`, so
the compiler's cell reads and writes are struct accesses instead of cached
property lookups (`docs/capture_lowering.md`). The pair below differs only in
that exporter change plus the two fixes it exposed (handler pops on `return`
inside `try`, `undefined` initialization of boxed class fields). Three
alternating runs after warmup, diagnostics and all 78 emitted files matching
Node on every launch:

| executable | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Node 25.2.1 / V8 | 3.219 s | 6.0 s | 0.80 GB |
| Value-vector build (`native_s350f/tsc-native`) | 15.289 s | 15.3 s | 1.30 GB |
| Typed-cell build (`native_s350g/tsc-native`) | **12.894 s** | **12.9 s** | 1.27 GB |

That is **15.7% less wall time** (1.19x) from one representation change, the
largest single step of the session: the compiler's factory-style closures
read their captured state constantly, and each read lost a property-cache
probe. Native is now 4.0x slower than V8 on this machine state (7.3x at the
start of Session 349). Raw record: `native_s350g/results/run-kelqcyte/`.

### Capture contexts (Session 350, slice C5b-1)

A function's captured bindings live in one scope record per activation
(`docs/capture_contexts_design.md`); closures and nested callees capture the
record instead of one cell per variable, so a call of a nested checker
function copies one handle instead of up to 249 and its frame shrinks
accordingly. The pair below differs only in that exporter change. Three
alternating runs after warmup, diagnostics and all 78 emitted files matching
Node on every launch:

| executable | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Node 25.2.1 / V8 | 3.361 s | 6.2 s | 0.79 GB |
| Typed-cell build (`native_s350g/tsc-native`) | 13.542 s | 13.5 s | 1.27 GB |
| Capture-context build (`native_s350h/tsc-native`) | **11.940 s** | **11.9 s** | 1.26 GB |

That is **11.8% less wall time** (1.13x). The generated C shrank from 67.4
to 62.1 MB (fewer cell allocations and environment copies). Native is now
3.55x slower than V8 on this machine state (7.3x at the start of Session
349). Raw record: `native_s350h/results/run-pk3jrt0a/`.

### In-object slots and frame slot coalescing (Session 350)

Two more steps on the same compiler workload, each measured against the
build before it with three alternating runs after warmup, diagnostics and all
78 emitted files matching Node on every launch:

| step | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Capture-context build (`native_s350h`) | 12.251 s | 12.2 s | 1.26 GB |
| + in-object slots (`native_s350i`, A3) | 11.903 s | 11.9 s | 1.27 GB |
| + frame slot coalescing (`native_s350j`) | **11.275 s** | **11.3 s** | 1.25 GB |
| Node 25.2.1 / V8 (same sessions) | 3.31–3.34 s | 6.1 s | 0.79 GB |

In-object slots (the first `inline_cap` values live in the object's cell)
gave 2.8%: the statistics build shows 98.6% of cached property gets hitting,
and of the shape hits 82% already landing inline, the rest being properties
added to constructor-made objects after construction. Frame slot coalescing
(reference locals share rooted frame slots by live range) gave 4.0%: the
compiler's frames shrink from 260,568 to 73,287 slots, so a call initializes
and a collection scans a fifth of the slots. Native is now 3.41x slower than
V8 on this machine state. Raw records: `native_s350i/results/run-535ko12w/`,
`native_s350j/results/run-yy2njb_k/`.

### Direct calls to nested declarations (Session 350, track C item 4)

Same compiler workload, three alternating runs after warmup against the
pointer-stable build, diagnostics and all 78 emitted files matching Node on
every launch:

| build | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Pointer-stable build (`native_s350k`) | 10.985 s | 11.0 s | 1.26 GB |
| + direct nested calls, lazy hoisting (`native_s350l`) | **9.722 s** | **9.7 s** | 1.23 GB |
| Node 25.2.1 / V8 (same session) | 3.245 s | 5.9 s | 0.80 GB |

A nested function declaration that is only ever called is no longer hoisted
as a closure value: the call passes the scope records of its free variables
directly (`checkTypeRelatedTo` hoisted about sixty helpers per call, 36% of
the closure allocations of a compile). The generated C has 4,621
`ts_call_value` sites instead of 22,545 and 27,461 environment-passing
direct calls instead of 9,970; it shrinks from 55.1 to 52.0 MB. Wall time
drops 11.5% (per run 9.614 / 9.722 / 9.949 s against 10.897 / 11.097 /
10.985 s); the site statistics build counts 5.63M closure allocations per
compile instead of 30.87M. Native is now 3.00x slower than V8 on this
machine state. Raw records: `native_s350l/results/run-c3ndk50f/`.

### Known-arity direct entry points (Session 350, track C item 1)

Same compiler workload, three alternating runs after warmup against the
direct-nested-call build, diagnostics and all 78 emitted files matching Node
on every launch:

| build | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Direct nested calls, lazy hoisting (`native_s350l`) | 9.573 s | 9.6 s | 1.23 GB |
| + known-arity direct entries (`native_s350m`) | **9.227 s** | **9.2 s** | 1.23 GB |
| Node 25.2.1 / V8 (same session) | 3.227 s | 5.9 s | 0.80 GB |

Every eligible function has a second entry whose scope records and
arguments are C parameters in the representation the body uses; the generic
`(args, nargs)` entry forwards to it, and direct call sites call it without
an argument array, an environment array or the environment register. On the
compiler 12,991 of 13,079 generic functions have a direct entry and 32,799
call sites use one (argument arrays 46,368 → 13,569, environment-register
references 39,548 → 13,655). Wall time drops 3.6% (per run 9.225 / 9.227 /
9.235 s against 9.572 / 9.573 / 9.574 s). Native is now 2.86x slower than V8
on this machine state. Raw records: `native_s350m/results/run-ur166mjt/`.

### Generated code at `-O2` with cold functions at O0 (Session 350)

Same compiler workload and the same generated C as the direct-entry build,
three alternating runs after warmup, diagnostics and all 78 emitted files
matching Node on every launch:

| build | median wall | median process CPU | median peak RSS |
|---|---:|---:|---:|
| Direct entries, `cc -O1` (`native_s350m`) | 9.333 s | 9.3 s | 1.23 GB |
| Direct entries, `cc -O2` (`native_s350m_o2`) | **8.359 s** | **8.4 s** | 1.23 GB |
| Node 25.2.1 / V8 (same session) | 3.282 s | 5.9 s | 0.80 GB |

Both builds mark the four giant cold functions (`__module_init`,
`createTypeChecker`, `createNodeFactory`, `createProgram`) `optnone`
(`TSAOT_NATIVE_COLD_O0=1`); the C compile takes 5 minutes at either level.
Wall time drops 10.4% (per run 8.343 / 8.359 / 8.391 s against 9.316 /
9.333 / 9.358 s). Native is now 2.55x slower than V8 on this machine state.
Raw records: `native_s350m_o2/results/`.

### Pattern benchmarks against V8 (Session 350)

Twelve tsc-style kernels (`benchmarks/patterns`, runner
`scripts/pattern_bench.sh`, scaled to 100–200 ms under Node; Node times include about 60 ms of startup), native best-of-3 against
Node best-of-3, same machine state, outputs checked against Node:

| kernel | before | end of session | ratio before → after |
|---|---:|---:|---:|
| flags / optional chaining / typeof loop | 2132 ms | 571 ms | 15.1x → 4.05x |
| `typeof` dispatch alone | 1376 ms | 88 ms | 17.9x → 1.1x |
| 32-case `switch` dispatch | 829 ms | 450 ms | 6.0x → 3.2x |
| small calls with object arguments | 1026 ms | 980 ms | 4.7x → 4.5x |
| array callbacks | 583 ms | 548 ms | 4.0x → 3.8x |
| closures with captured variables | 392 ms | 385 ms | 3.1x → 3.0x |
| arrays of objects | 329 ms | 337 ms | 3.05x → 3.1x |
| shape-polymorphic object literals | 402 ms | 361 ms | 3.3x → 3.0x |
| scanner-style string loop | 364 ms | 253 ms | 2.6x → 1.8x |
| tree recursion | 147 ms | 126 ms | 1.4x → 1.2x |
| string building | 153 ms | 149 ms | 1.3x → 1.3x |
| Map with string keys | 92 ms | 90 ms | 0.88x |
| method objects | 47 ms | 45 ms | 0.69x |

Kernels after the fixed condition temporaries and the three micro-patterns
(`native_s350x2`'s emitter; best-of-3, Node best-of-3 in the same run):

| kernel | before | after |
|---|---:|---:|
| arrays of objects | 326 ms | 283 ms |
| 32-case `switch` dispatch | 466 ms | 399 ms |
| closures with captured variables | 373 ms | 345 ms |
| small calls with object arguments | 984 ms | 936 ms |
| tree recursion | 130 ms | 122 ms |
| shape-polymorphic object literals | 322 ms | 317 ms |
| array callbacks, flags, strings, maps, methods | — | within noise |

Compiler A/Bs for the slice (three alternating runs each, outputs validated):

| build | median wall | note |
|---|---:|---|
| `native_s350o` (implicit returns) | 8.397 s | baseline |
| `native_s350p` (static typeof strings) | 8.387 s | noise |
| `native_s350q` (typeof fusion + switch chain) | **8.257 s** | 2.0% less than `p` (8.426 s in its own session) |
| `native_s350r` (switch jump tables) | 8.364 s | noise against `q` (8.322 s) |
| `native_s350s` (lazy root frames) | **8.235 s** | 1.1% less than `r` (8.329 s) |
| `native_s350u` (object literal and constructor layouts) | **7.911 s** | 1.8% less than `s` (8.052 s in its own session); Node 3.238 s |
| `native_s350v` (slot-first inline-cache probe) | **7.591 s** | 4.2% less than `u` (7.925 s in its own session); Node 3.218 s |
| `native_s350w` (condition temporaries kept raw) | (invalid) | the run recorded as this A/B measured `v` against `u` again (the script's binary paths were not updated); `w` also miscompiled reassigned boolean parameters and reported 1,419 bogus diagnostics on the compiler |
| `native_s350x2` (condition temporaries fixed + tag compares, inline element reads, raw loop flags) | **7.416 s** | 3.3% less than `v` (7.668 s in the same session); Node 3.271 s; diagnostics zero, outputs validated |
| `native_s350x3` (direct calls to namespace member functions) | **7.242 s** | 2.1% less than `x2` (7.395 s in the same session); Node 3.253 s; diagnostics zero, outputs validated |
| `native_s350x4` (guarded direct calls for one-closure method keys) | **7.226 s** | 1.5% less than `x3` (7.340 s in the same session); Node 3.267 s; diagnostics zero, outputs validated |
| `native_s350x5` (anchored regexp fast path) | **6.949 s** | 4.9% less than `x4` (7.309 s in the same session); Node 3.353 s; diagnostics zero, outputs validated |
| `native_s350x6` (typed direct-entry returns) | **6.851 s** | 0.8% less than `x5` (6.907 s in the same session); Node 3.300 s; diagnostics zero, outputs validated |
| `native_s350x7` (array-derived interfaces as array receivers) | **6.764 s** | 4.3% less than `x6` (7.072 s in the same session); Node 3.275 s; diagnostics zero, outputs validated |
| `native_s350x8` (scalar-replacement outer-alias fix, loop-body stack slots to the frame arena) | 6.593 s | noise level against `x7` (6.609 s in the same session); Node 3.271 s; diagnostics zero, outputs validated |
| `native_s350x9` (stack-allocated non-escaping closures, hoisted stack cells) | **6.404 s** | 1.4% less than `x8` (6.494 s in the same session); Node 3.231 s; peak RSS 1,171 → 1,160 MB; diagnostics zero, outputs validated |
| `native_s350x10` (inline fast path for function-value calls) | 6.478 s | 1.1% less than `x9` (6.553 s in the same session), within noise (two of three run pairs equal); Node 3.297 s; diagnostics zero, outputs validated |
| `native_s350x11` (dirty slot ranges for remembered objects) | 6.395 s | no measurable change against `x10` (6.397 s in the same quiet session; a run shared with a statistics compile read +1.0% and was discarded); Node 3.222 s; diagnostics zero, outputs validated |
| `native_s350x12` (constructor layouts behind captured cells) | 6.580 s | 2.1% less than `x11` (6.720 s in the same run; a statistics compile shared one core, Node 3.428 s, all four run pairs favour `x12`); diagnostics zero, outputs validated |
| `native_s350x13` (field-less class instances as plain objects, `declare` fields) | 6.230 s | 1.4% less than `x12` (6.319 s in the same quiet run, all four pairs agree; a run under the stalled statistics compile read +0.8% and was discarded); Node 3.266 s, native 1.91x; diagnostics zero, outputs validated |
| `native_s350x14` (absent-property cache) | 6.223 s | 0.9% less than `x13` (6.278 s in the same run, all four pairs agree; a first A/B under the owner's desktop load read 6.359 → 6.373 s); Node 3.354 s; diagnostics zero, outputs validated |
| `native_s350x15` (struct fields only in sized instances; collector skips the registry) | 6.236 s | 0.4% less than `x14` (6.260 s; three A/Bs agree within noise, 11 of 12 timed pairs); Node 3.329 s; diagnostics zero, outputs validated |
| `native_s350x16` (capture by value for immutable bindings) | 6.066 s | 2.7% less than `x15` (6.232 s in the same run, three timed pairs −2.0 to −2.9%); Node 3.311 s; RSS 1,166 → 1,089 MB; diagnostics zero, outputs validated |
| `native_s350x17` (lazy closure values for nested declarations) | 5.945 s | 0.5% less than `x16` (5.973 s in the same run, all four pairs agree); Node 3.243 s; RSS 1,089 → 1,100 MB; diagnostics zero, outputs validated |
| `native_s350x18` (value captures, round 2: settled bindings) | 5.953 s | 0.8% less than `x17` (6.000 s in the same quiet run, all four pairs agree); Node 3.268 s; RSS 1,100 → 1,155 MB; diagnostics zero, outputs validated |
| `native_s350x19` (splice fast paths: discarded results) | 6.021 s | 1.6% less than `x18` (6.121 s in the same run, all four pairs agree, desktop load present); Node 3.423 s; RSS 1,155 → 1,058 MB; diagnostics zero, outputs validated |
| `native_s350x20` (string + integer without the intermediate string) | 6.139 s | no measurable change against `x19` (two A/Bs: −0.8% and +0.1%, Node 3.36–3.49 s); kernel `string_keys` 230 → 198 ms; diagnostics zero, outputs validated |
| `native_s350x65` (live array iterators; for..of over unclassified values; mixed unions without a builtin kind) | 4.305 s | neutral against `x64` (4.305 vs 4.290 s and 4.335 vs 4.344 s); four compiler functions changed (latent union miscompiles); Node 3.27-3.30 s -> 1.32x
| `native_s350x64` (exotic links on prototype chains; Reflect receivers; proxy cells padded) | 4.305 s | neutral against `x63` (4.305 vs 4.323 s and 4.354 vs 4.373 s); no proxies in the compiler; Node 3.29-3.32 s -> 1.31x
| `native_s350x63` (fresh objects' prototypes linked without moving the cache epochs) | 4.323 s | about 1.7% less than `x62` (4.347 vs 4.424 s and 4.323 vs 4.397 s, all six pairs faster); epoch moves 200k -> 3.2k, slow additions 1.45M -> 0.30M, out-of-line reads 4.72M -> 2.01M per compile; per-site inline absent entries measured neutral at +6.6 MB of code, not adopted; Node 3.29-3.34 s -> 1.31x
| `native_s350x62` (lazy frames with register homes: frame filled only on the linked slow path) | 4.431 s | neutral against `x61` (4.431 vs 4.431 s and 4.435 vs 4.444 s, five of six pairs equal or faster); 3,315 function bodies with homes, 2,097 linked slow-path sites; binary 49.15 -> 49.10 MB; Node 3.31-3.34 s -> 1.34x
| `native_s350x61` (literal-identity cache for compiled regular expressions) | 4.379 s | about 0.7% less than `x60` (4.379 vs 4.413 s and 4.384 vs 4.412 s); kernel `path_regexps` 261 -> 238 ms; Node 3.28 s -> 1.34x
| `native_s350x60` (numeric `+` of a boxed numeric operand) | 4.513 s | neutral against `x59` (4.513 vs 4.543 s and 4.520 vs 4.515 s); kernel `flags_truthy` 403 -> 360 ms; Node 3.36 s -> 1.34x
| `native_s350x59` (iteration callbacks: thisArg bound, empty reduce throws) | 4.460 s | neutral against `x58` (4.492 vs 4.496 s and 4.460 vs 4.437 s); Node 3.33-3.37 s -> 1.34x
| `native_s350x58` (array callbacks: the container argument, one dispatch per loop) | 4.449 s | neutral against `x57` (4.479 vs 4.491 s and 4.449 vs 4.489 s); kernel `callbacks` 509 -> 284 ms; Node 3.32 s -> 1.34x
| `native_s350x57` (object literals as producer layouts of the static slots) | 4.625 s | about 1.4% less than `x56` (4.625 vs 4.674 s and 4.685 vs 4.766 s, all six pairs faster); hinted sites 19,781 -> 24,553; Node 3.44-3.63 s under desktop load -> 1.32x
| `native_s350x56` (ToInt32/ToUint32 as one FJCVTZS on ARMv8.3) | 4.591 s | about 2.3% less than `x55` (4.608 vs 4.698 s and 4.591 vs 4.723 s, all six pairs faster); Node 3.47 s under desktop load -> 1.32x
| `native_s350x55` (foreign receivers of typed class-field accesses: Proxy-or-unsized guard behind a flag raised by relinks and borrowed methods) | 4.668 s | neutral against `x53` (4.668 vs 4.673 s and 4.691 vs 4.700 s; the flag stays down in the compiler; the first build, which raised it at module init, was 5% slower); Node 3.46 s under desktop load -> 1.35x
| `native_s350x53` (escape and SROA soundness: aliases handed back to the caller, compact nest edges, closure creation, reassigned locals) | 4.500 s | neutral against `x52` (4.502 vs 4.513 s and 4.500 vs 4.513 s; only zero-count sites changed); allocations unchanged (13.20M per compile); Node 3.28 s -> 1.37x
| `native_s350x52` (deep phantoms per field; loads into primitives carry no reference) | 4.570 s | neutral against `x51` (4.571 vs 4.542 s and 4.570 vs 4.550 s); allocations 13.27M -> 13.20M per compile; Node 3.31 s -> 1.38x
| `native_s350x51` (scope records of ordinary functions on the C stack when no closure or callee outlives the frame) | 4.488 s | neutral against `x50` (4.512 vs 4.487 s and 4.488 vs 4.512 s); allocations 14.29M -> 13.27M per compile, minor collections 311 -> 291; Node 3.24-3.25 s -> 1.38x
| `native_s350x50` (callbacks of non-retaining builtins stay on the stack; returned by-value captures folded at creation) | 4.497 s | about 0.6% less than `x49` (4.535 vs 4.560 s and 4.497 vs 4.529 s); closure allocations 1.062M -> 0.949M per compile; Node 3.25-3.28 s -> 1.38x
| `native_s350x49` (summaries for large recursion nests: compact summaries, widening, big scope records external) | 4.576 s | neutral against `x48` (4.576 vs 4.532 s, 4.660 vs 4.660 s, 4.657 vs 4.651 s); closure allocations 1.283M -> 1.062M per compile; Node 3.27-3.34 s -> 1.39x
| `native_s350x48` (escape analysis soundness: stores through a parameter's contents; phantom links, deep/external loads, dynamic key) | 4.538 s | neutral against `x47` (4.538 vs 4.537 s and 4.558 vs 4.568 s); closure allocations 1.374M -> 1.283M per compile; Node 3.26-3.27 s -> 1.39x
| `native_s350x47` (collection dispatch: derived interfaces, loud receivers, cached iterator next) | 4.556 s | neutral against `x45` (4.556 vs 4.533 s and 4.560 vs 4.555 s); dictionary lookups 11.5M -> 10.7M per compile; Node 3.27-3.29 s -> 1.39x; diagnostics zero, outputs validated |
| `native_s350x45` (shaped named properties on arrays) | 4.536 s | about 0.5% less than `x43` (4.536 vs 4.566 s and 4.549 vs 4.563 s); dictionary lookups 14.8M -> 11.5M per compile; RSS 884 -> 865 MB; Node 3.27-3.31 s -> 1.38x; diagnostics zero, outputs validated |
| `native_s350x43` (runtime inline caches for hidden fields; hasOwnProperty.call shortcut) | 4.595 s | about 0.8% less than `x42` (4.595 vs 4.632 s and 4.601 vs 4.641 s, five of six pairs); dictionary lookups 19.6M -> 14.8M per compile; Node 3.27-3.29 s -> 1.40x; diagnostics zero, outputs validated |
| `native_s350x42` (cursor-driven for..of over Map/Set) | 4.627 s | neutral for the compiler (4.641 vs 4.611 s and 4.627 vs 4.632 s against `x41`: its Map iteration runs through the core.ts iterator helpers); the Map for-of kernel 348 -> 48 ms (Node 66 ms); Node 3.27-3.30 s -> 1.41x; diagnostics zero, outputs validated |
| `native_s350x40` (inline element store, inlined scanner char-code read) | 4.615 s | about 0.6% less than `x39` (4.615 vs 4.641 s and 4.636 vs 4.671 s, five of six pairs); binary 50.01 -> 50.21 MB; Node 3.28-3.30 s -> 1.41x; diagnostics zero, outputs validated |
| `native_s350x39` (pretenured construction: guarded constructions allocate old) | 4.667 s | 1.4-2.0% less than `x38` (4.667 vs 4.761 s and 4.686 vs 4.751 s, all six pairs); minors 401 -> 325, GC pauses 384 -> 251 ms; RSS 821 -> 884 MB; Node 3.28-3.29 s -> 1.42x; diagnostics zero, outputs validated |
| `native_s350x38` (full-collection pacing by reclaimed fraction) | 4.734 s | 2.3-2.8% less than `x37` (4.734 vs 4.868 s and 4.752 vs 4.865 s, all six pairs); full collections 6 -> 3 per compile, pauses 498 -> 384 ms; RSS 811 -> 821 MB; Node 3.27-3.29 s -> 1.44x; diagnostics zero, outputs validated |
| `native_s350x37` (producer layouts for the static slots; capacity hint off) | 4.882 s | about 1% less than `x33` (4.882 vs 4.924 s, three alternating runs), memory unchanged; with `TSAOT_CTOR_CAPACITY=16` (`x36`) 4.906 vs 5.024 s (-2.3%) at RSS 892 vs 813 MB; 19,781 hinted sites, cached reads 146M -> 62M per compile, binary 52.5 -> 50.0 MB; diagnostics zero, outputs validated |
| `native_s350x33` (static slots at interface-typed property sites) | 4.881 s | about 10% less than `x32` in two alternating rounds (medians 4.881 vs 5.463 s and 4.977 vs 5.530 s, all six pairs -5% to -11%); Node 3.28 / 3.39 s -> 1.49x; 8,312 hinted sites, 352M static reads per compile, binary 55.9 -> 52.5 MB; diagnostics zero, outputs validated |
| `native_s350x32` (guarded direct construction: predicted constructor functions called directly) | 5.434 s | 0.5-1% less than `x31` in two alternating rounds (medians 5.434 vs 5.537 s and 5.528 vs 5.556 s, five of six pairs favor `x32`); Node 3.29 / 3.37 s; 53 guards in the compiler; root pushes 32.66M -> 30.75M per compile; diagnostics zero, outputs validated |
| `native_s350x31` (slot-precise barriers in the slow property stores) | — | no measurable change against `x30` (quick noEmit pairs 4.64/4.41, 4.56/4.56, 4.50/4.43 s); whole-cell marks 1.68M → 1.67M per compile |
| `native_s350x30` (callback specialization: clones bound to module-level callbacks) | 5.483 s | 1.3% less than `x28` (5.554 s in the same run, all three pairs agree; Node 3.30 s → 1.66x); 54 clones in the compiler; diagnostics zero, outputs validated |
| `native_s350x29` (shape-ancestor validation of inline-cache hits; not adopted) | 6.022 s | 2.4% MORE than `x28` (5.879 s in the same run; pairs +2.4%, +12%, −2.3% on a loaded machine), binary +16%; the mechanism took 312M of 314M validations but no wall-clock gain; reverted |
| `native_s350x28` (int32 locals for bitwise-only uses) | 5.620 s | about 1% less than `x26` over three A/Bs on a loaded machine (5.717 s in the last run; Node 3.28–3.49 s); `ts_to_int32` calls in the generated compiler 8,311 → 4,913; diagnostics zero, outputs validated |
| `native_s350x27` (cached additions performed in line at the store site; not adopted) | 5.553 s | 0.2% MORE than `x26` (5.540 s in the same run; pairs +2.8%, +0.2%, −0.5%), binary +4%; out-of-line stores 10.1M → 3.8M but no wall-clock gain; reverted |
| `native_s350x26` (per-site addition entries of the store cache; inherited read-only writes rejected) | 5.494 s | 1.0% less than `x25` (5.548 s in the same run, all three pairs agree; Node 3.23 s → 1.70x); additions 6.93M via the site entry; diagnostics zero, outputs validated |
| `native_s350x25` (inline fast paths: strict equality, ToInt32, truthiness) | 5.637 s | neutral to slightly positive against `x24` (two A/Bs: −0.3% and −0.9%, Node 3.26–3.36 s); the outlined helpers vanish from the profile; diagnostics zero, outputs validated |
| `native_s350x24` (regexp first-character prefilter) | 5.613 s | 1.3% less than `x23` (5.689 s in the same run, all three pairs agree; Node 3.27 s → 1.71x); kernel `path_regexps` 844 → 339 ms (Node 112 ms); diagnostics zero, outputs validated |
| `native_s350x23` (strings round two: equality length check, literal boxing in line, builder digits, view hashes, numeric relational) | 5.696 s | 1.6% less than `x22` (5.790 s in the same run, all three pairs agree; Node 3.25 s → 1.75x); root pushes 49.0M → 32.7M per compile, GC pause 598 → 492 ms; diagnostics zero, outputs validated |
| `native_s350x22` (sparse element storage for far stores) | 5.745 s | 4.1% less than `x20` (5.988 s in the same run, all four pairs agree; Node 3.23 s → 1.78x), peak RSS 1,139 → 811 MB; kernel `sparse_stores` 42 ms against Node's 138 ms; diagnostics zero, outputs validated |
| `native_s350x21` (tiny leaf direct entries always_inline) | 6.253 s | 1.5% MORE than `x20` (6.160 s in the same run, all four pairs agree); the rule is off by default, the production build stays `x20`'s; diagnostics zero, outputs validated |

### Inline-cache path statistics (Session 350, `native_s350s_stats`)

One compile of the compiler sources with `TSAOT_NATIVE_STATS=1`, after the
lazy-frame slice (`pic_paths` counters added in this session):

| path | reads per compile | share of hits |
|---|---:|---:|
| shape entry 0 (monomorphic) | 214.3M | 36.7% |
| shape entries 1–3 | 13.5M | 2.3% |
| slot/key validation (same slot, other shape) | 360.4M | 61.7% |
| out of line (`ts_get_pic_checked`) | 13.4M | — |
| total reads / hits | 592.6M / 584.2M | 98.6% hit |

Root frame pushes per compile: 561.7M before lazy frames, 410.2M after.
The dominant read path is the slot/key validation, reached today only after
the four shape-entry compares miss; a slot-first probe would make it the
first test.

New kernel `benchmarks/patterns/ctor_functions.ts` (function constructors
reached through a factory object, `new` on the function value, ten
`this.x = v` stores per instance, 6M instances): native 265 ms, Node 96 ms
(2.7x). Its constructors capture nothing, so they already adopted their
layout; the time is the generic `new` on a function value (`ts_construct`
and `ts_call`, 15% of samples), the write barrier's handle-table loads (9%),
allocation (8%) and the loop's inline-cache reads and writes. The same
pattern in the compiler (`Node`, `Token`, `Identifier`) did NOT adopt its
layout until `x12`, because `this` sits after the captured cells.

New kernel `benchmarks/patterns/links_objects.ts` (the checker's
`SymbolLinks` pattern: a brand-only class expression whose instances are
populated lazily and read back through optional members, 24M operations):
native 1,388 ms against Node 150 ms (9.1x) before the field-less-instance
change, 914 ms (6.1x) after it. Half of the remaining samples are reads of
properties the receiver does not have yet (`l.count === undefined`), which
miss the inline probe and walk every out-of-line step.

Kernel `links_objects` after the absent-property cache: 487 ms against Node
151 ms (3.2x; 9.1x at the start of the day). Its 39.0M absent reads cost 6
fills and 39.0M cache hits; `prop_find` calls fell from 117M to 115k.

