# garnet — agent operations guide (build / investigation / debugging / search / testing)

A practical handbook: read it and you'll understand the whole procedure, up to "fixing a single bug in garnet and committing it safely."
Policy and discipline live in [`CLAUDE.md`](../CLAUDE.md); the first-time setup procedure is in [`CLAUDE_CODE_HANDOFF.md`](../CLAUDE_CODE_HANDOFF.md);
the true source of truth for progress is [the end of `docs/TODO.md`](./TODO.md). **Reading the tail of TODO.md first** is where everything starts.

garnet is a TypeScript → C AOT compiler. Pipeline:

```
  in.ts ──(exporter/ = TS)──▶ IR(JSON) ──(analyzer/ = Rust, bin name tsaot)──▶ C ──(cc)──▶ native
                                          └ emit_c.rs does IR→C
  native links runtime/ts_rt.c (shared runtime, unity-includes json_core.c)
```

- `exporter/` … TS→IR. The sole frontend implementation (TypeScript). cell/capture, scope resolution, type-driven annotation.
- `analyzer/` … Rust. **The main implementation**. escape/devirt/sroa/i64 analysis + `emit_c.rs`. The cargo binary name is `tsaot`.
- `analyzer_ts/` … The frozen TS version of the analyzer (**do not modify**). Its roles are ① flagship benchmark ② byte-parity oracle.
- `runtime/ts_rt.c` … NaN-boxing, object model, GC, stdlib. **A primary development target**.

---

## 1. Build

The three artifacts can be built individually (`scripts/setup.sh` builds all of them). You only need to rebuild **the layer you changed**.

```bash
# exporter (when you change exporter.ts. Output is exporter/exporter.js = a gitignored build artifact)
cd exporter && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
  --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop
# analyzer (Rust. When you change emit_c.rs etc.)
cd analyzer && cargo build --release          # → analyzer/target/release/tsaot
# runtime (when you change ts_rt.c. build/rt.o is a shared cache used by many harnesses)
gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o
```

### The garnet driver (compile one program by hand)

```bash
./garnet foo.ts            # emit foo.c and build the native `foo`
./garnet -o foo.c foo.ts   # specify the output C name (★ -o must always end in .c; the executable is the name with .c removed)
./garnet -c foo.ts         # emit C only (no cc)
./garnet -S foo.ts         # C to stdout
```

Key env vars: `TSAOT_UNTYPED=1` (everything is any = type-driven optimization OFF; correct JS semantics but slow. Essential for validating ill-typed input),
`TSAOT_CC="gcc -O2"` (default `cc -O2`), `TSAOT_ANALYZER=rust|ts|native`, `--rt-stats` (see below), `--profile`.

> ★ **Pitfall**: `./garnet -o out out.ts` (no .c) passes out to ld as an object and fails with "unknown file type".
> Always use `-o out.c` and run `./out`.

---

## 2. The core work loop = V8 differential testing

garnet's discipline is **"compare output against V8 (= node) and fix bugs one at a time."** The established recipe is as follows.

### 2.1 How to build the oracle (node = V8)

garnet emits with `module: ESNext`, so make the oracle **ESM (.mjs) too, to align strict semantics** (don't introduce sloppy-mode differences).

```bash
# the result of running in.ts under V8 (= the expected value)
node -e '
  const ts=require("./exporter/node_modules/typescript"),fs=require("fs");
  const js=ts.transpileModule(fs.readFileSync("in.ts","utf8"),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  fs.writeFileSync("in.mjs",js);'
node in.mjs
```

There's also a ready-made differential harness (source `scripts/difftest.sh` and run `dt "name" 'function main(){...}main();'`).
But **★ sourcing a bash-assuming script from zsh can misfire: a word-splitting difference in `$CC` keeps running the old binary**
(a CLAUDE.md lesson). **Always factor probes out into a bash file and run them with `bash probe.sh`.**

### 2.2 Probe template for bug hunting (differential hunting)

Compare many categories against node in one shot and pick out only the DIFF lines. In a `bash` file:

```bash
#!/usr/bin/env bash
ROOT=$(git rev-parse --show-toplevel); W=/tmp/hunt; mkdir -p "$W"
run(){ echo "$2" > "$W/t.ts"
  node -e 'const ts=require("'"$ROOT"'/exporter/node_modules/typescript"),fs=require("fs");
    fs.writeFileSync("'"$W"'/t.mjs",ts.transpileModule(fs.readFileSync("'"$W"'/t.ts","utf8"),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);'
  local no=$(node "$W/t.mjs" 2>&1|tr '\n' '|')
  "$ROOT/garnet" -o "$W/t.c" "$W/t.ts" >/dev/null 2>&1 || { printf "%-20s BUILDFAIL\n" "$1"; return; }
  local ao=$("$W/t" 2>&1|tr '\n' '|')
  [ "$no" = "$ao" ] || printf "*** %-16s node=[%s] aot=[%s]\n" "$1" "$no" "$ao"
}
run "toFixed -0" 'console.log((-0).toFixed(2));'
run "ws eq"       'const x:any="\t"; console.log(x==0);'   # any to dodge the type error / TSAOT_UNTYPED=1
# ... line up 40–50 cases
```

Tips for judging:
- **REJECT / BUILDFAIL are mostly non-bugs**: ① ill-typed TS (`0==""`, `[]+{}`, etc. are type errors in strict TS → garnet refuses loudly.
  To exercise the semantics, use `TSAOT_UNTYPED=1`) ② unimplemented stdlib is "UNSUPPORTED" (loud reject = healthy; not a silent miscompile)
  ③ TS lib-target origin (`toSorted` is es2023).
- **Watch out for benign DIFFs**: output differences on exceptions (node prints a verbose ESM stack, garnet one line), the inspect display of `-0`, and the like.
  Check **whether the behavior is the same** (both throw / same number).

---

## 3. Debugging procedure (crashes, wrong values)

Principle: **measurement over theory**. Minimal reproduction → a probe that pins down the mechanism.

1. **Minimize**: sweep the iteration count N (N=0/1/2…), strip features one at a time (remove capture / stop escape).
   Capture the **boundary**, e.g. "hand-unrolled passes but the loop crashes."
2. **Isolate with env knobs** (change behavior and watch the correlation with symptoms = a correlation between symptom count and mechanism-invocation count is the clincher):
   - `TSAOT_GC_YOUNG_THRESHOLD=1` … minor GC on every alloc (maximum collection stress; cells
     never move, so a stale reference can only outlive its cell)
   - `TSAOT_GC_ZAP=1` … poison dead cells with 0xDD (use-after-free detection. **A clean undefined/all-zeros
     = the signature of an unmarked death + region reuse**; 0xDD = a read of a freed cell)
   - `TSAOT_GC_PROTECT=1` … freed cells are zapped and quarantined (up to 64 MiB; `=N` for N MiB)
     instead of reused, and a collection that reaches one aborts naming it: a missing root or
     write barrier (`docs/gc_v2_design.md` §6.8.1)
   - `TSAOT_UNTYPED=1` … isolate whether type-driven optimization (SROA/unbox) is the cause
   - `garnet --stack-check` … every escape-analysis `Stack` object (class instance, scope record,
     closure) lives in a never-reused quarantine and dies with its activation; a dead one the
     collector reaches is reported with its site and C function (`docs/stack_check_design.md`).
     The first thing to run on a value that changes with the stack layout. Whole suites:
     `TSAOT_STACK_CHECK=1 TSAOT_CC="gcc -O2 -DTSAOT_STACK_CHECK" scripts/gate.sh conf all`;
     `TSAOT_STACK_CHECK_CONTINUE=1` reports every site, `TSAOT_STACK_CHECK_FULL_EVERY=N` adds a
     full collection every N minor ones (`TSAOT_GC_FULL_THRESHOLD_BYTES` is no substitute: once
     the heap exceeds it, every allocation collects).
3. **Backtrace** (cheap if the crash is instantaneous):
   ```bash
   cat > /tmp/bt.lldb <<EOF
   settings set target.input-path /tmp/input     # when input comes from stdin
   run
   bt 16
   quit
   EOF
   ( ulimit -s 65520; lldb -b -s /tmp/bt.lldb ./binary ) | grep -E "frame #|stop reason"
   ```
   For deep stacks like selfhost native, use `ulimit -s 65520`.
4. **ASan**: `gcc -O1 -g -fsanitize=address -DTS_ASAN_ENABLED ...`. **★ But an ASan-only guard
   (e.g. the readability probe on `ts_heap_ptr`) can hide a bug that's real in a non-ASan production build** (the C1 lesson). Always confirm whether it reproduces without ASan too.
5. **Runtime measurement `--rt-stats`** (`-DTSAOT_RT_STATS`): GC count/pause, alloc, handle_alloc, the probe-length histogram for find_prop/intern/map_find,
   call_env_malloc, and concat, to stderr (`TSAOT_RT_STATS_FILE=path` for a file).
   Judge perf by "the distribution (hist) and workload dependence, not the avg."
6. **Temporary instrumentation in the runtime**: copy `runtime/ts_rt.c` to `/tmp` → insert `fprintf(stderr,...); fflush(stderr);` →
   `gcc -O2 -c copy.c -o rt_dbg.o` → link with the generated C. Trace the time series of a cell's kind / slot value / promotion and evacuation.
   **fflush is mandatory for stderr** (otherwise it's lost, unflushed, before the crash).
7. **Read the generated C**: `./garnet -c -o /tmp/x.c x.ts`, then `awk '/static tsv fn_0_main/,/^}/' /tmp/x.c`.
   You can see FrameArena/Stack/Heap alloc-site annotations, the AllocObject location of a cell, the env of ts_call, and so on.

---

## 4. Project search map (where to find what)

| What you're looking for | Location / grep |
|---|---|
| What's being worked on now / recent decisions | **The end** of `docs/TODO.md` (in session-number order; the single source of truth) |
| Design intent by feature | `docs/*_design.md` (classes / generators / exceptions / async / capture_lowering …) |
| The overall GC plan and current status | `docs/gc_moving_plan.md`; the Rust migration plan `docs/refactor_master_plan.md` |
| Runtime implementation (stdlib / GC / boxing) | `runtime/ts_rt.c` (~446KB, one file); `runtime/ts_rt.h` (types, inline, NaN-box macros) |
| The implementation of a given JS API | `grep -nE "ts_<name>\|\"<method>\"" runtime/ts_rt.c` |
| Number/string/coercion conversions | `ts_number_coerce` / `ts_to_num` (raw-bit reinterpretation) / `ts_str_*` / `ts_math_*2` |
| IR→C emission | `analyzer/src/emit_c.rs`; the alloc strategy is in `analyzer/src/codegen.rs` (`decide`) |
| The exporter's scope/capture | `exporter/exporter.ts` (`cellBindings` / `cellAccess` / `captureLoopBody` / `setupForOfCaptureCells`) |
| Conformance tests | `tests/conformance/exhaustive/<category>/*.ts` (V8 oracle; no separate expected file needed) |
| Run/gate scripts | `scripts/*.sh` (the single entry point is `scripts/gate.sh`) |

Keep in mind the whole-program premise that module linking is nearly free thanks to `ts.Symbol` keying + the checker's alias resolution.

---

## 5. Testing after a bug fix (the required gates depend on the kind of change)

First determine **the kind of change**. This decides what validation you need:

| Kind | Example | Generated C | Required gates |
|---|---|---|---|
| **A. Runtime only** | A behavior fix in `ts_rt.c` | **Unchanged** | conf + unit + gc (+ bench if affected). **parity is irrelevant** (emitc_diff compares generated C) |
| **B. exporter / output change** | A fix that changes the IR / generated C | Changes | conf + bundler + selfconf + **emitc_diff** (if it diverges from the frozen twin, move it to the allowlist) |
| **C. Behavior-preserving Rust refactor** | A non-functional change to emit_c.rs | Byte-identical is the goal | **byte-parity via emitc_diff** is primary. conf/unit too |

Commands (single entry point `scripts/gate.sh <cmd>`):

```bash
scripts/gate.sh conf all      # all conformance (V8 differential) ★ main gate
scripts/gate.sh unit          # runtime unit + analyzer unit
scripts/gate.sh gc            # GC stress (threshold=1 × O2/ASan/runtime)
scripts/gate.sh bundler       # module bundling, 39 fixtures
scripts/gate.sh bench [flt]   # correctness of 99 benchmarks + time budget
scripts/gate.sh selfconf      # V8 differential of the frozen twin
scripts/gate.sh parity        # = scripts/emitc_diff.sh (Rust emit vs frozen-TS emitc, byte-wise)
scripts/gate.sh ir-parity     # determinism of exporter output (snapshot comparison)
```

**Add a minimal test to conformance for every new feature/fix** (just drop in `tests/conformance/exhaustive/<cat>/xxx.ts`.
V8 is the oracle, so no expected file is needed. But **the default is typed** = ill-typed input gets REJECTED, so
for things like loose coercion, either use `any` to make it typed-valid, or put it in a separate track).

### When emitc_diff diverges from the frozen twin

When an exporter/analyzer change produces a new IR/optimization pattern, **the frozen `analyzer_ts` and Rust can diverge**.
- If **both outputs are correct** (they match V8) and the difference is an alloc-strategy name (Stack↔FrameArena etc., identical behavior) → **benign**.
  Add a `parity\t<category>/<slug>\t<reason>` line to `scripts/frozen_known_diffs.tsv` to allowlist it (DIFF→KNOWN).
- If the frozen side produces a wrong value → since the frozen side must not be modified, record it in the allowlist the same way (Rust is production and correct).

### Completion criteria (CLAUDE.md)

**All conformance green + unit + bench (perf budget) + all bundler green**, plus gate gc if you touched GC, and selfconf/emitc_diff if you touched the exporter.
**Zero perf regression** (if you add a branch to the hot path, gate it behind a single predictable branch).

---

## 6. Committing

- **The message is in English** (user instruction). The body is "what and why" + a trailing `Verified:` line (the results of every gate you ran).
  For silent-miscompile fixes, you may also add a `Lesson:` paragraph.
- **Straight-line commits to main** (a solo project; the whole history is main). **Do not commit until the user says "commit."**
- Internal code identifiers and the cargo binary name are still `tsaot` (renaming is on hold because the blast radius is large). Do not bulk-replace without an explicit instruction.
- **Always append progress to the end of `docs/TODO.md`** (do not put progress in memory).

---

## 7. Gotchas (hard-won; they bite every time)

- **zsh vs bash**: don't source bash-assuming functions (like `dt`) from zsh. Factor probes out into a bash file.
- **`garnet -o` requires `.c`** (§1).
- **An ASan-only guard hides a bug that's real in a non-ASan production build**. Always confirm with large non-ASan inputs too (the C1 crash surfaced this way).
- **The selfhost milestone is the only net for scale-dependent UB**: even when small-input conformance is all green, there are bugs that first surface
  on the 66k-instruction selfhost (`scripts/bench_selfcompile.sh`'s emit-native takes hundreds of seconds = heavy. **Requires an agreed time window**).
- **Don't leave heavy gates/benchmarks running in the background**: keep them in the foreground + a watchdog (detect a stuck fixture binary via etime×cpu and kill it).
  Absolute numbers under machine load are untrustworthy → **for A/B, alternate runs on the same input (ABAB)**, via rt.o swap or a full-build comparison.
- **-0 (negative zero)**: behavior diverges between a `< 0` test (which treats -0 as non-negative) and a sign-bit test. `%f`/printf prints -0 as "-0", so
  route the absolute-value path through `fabs`.
- **cell / capture**: when a closure captures a loop variable, variable writes must go through the capture cell (StoreField VALUE).
  Captured `const`/`let` declared in the loop **body** get a fresh cell per iteration (`emitPerIterationBodyCells`).
- **Type-driven optimization (unbox/SROA) easily drops values**. Watch out for `never`/conditional types and per-body processing; err on the safe side.
- **A namespace mismatch between METHOD keys and FIELD keys** is a frequent culprit in silent-DIFFs. Keep double-storage symmetric across every mutation operation.

---

- **`dt` caches the regexp/unicode support objects (`build/regexp/*.o`, `build/quickjs/*.o`) and does
  not rebuild them when their sources or `runtime/ts_rt.h` change.** A stale adapter object shows up as
  a link error such as `Undefined symbols: _ts_number_coerce` (a symbol that has since become
  `static inline`). After editing anything under `runtime/regexp/` or the runtime header, run
  `rm -f build/regexp/*.o build/quickjs/*.o` before the next `dt`. The gates build their own copies.
- **Per-site statistics builds (`TSAOT_SITE_STATS=1`, `TSAOT_NATIVE_STATS=1`) must compile the
  generated C at `-O0`.** With the statistics macros expanded into every inline cache probe the
  compiler's C takes more than 50 CPU minutes at `-O1` (two abandoned attempts in Session 350);
  at `-O0` it takes one minute and the counts are the same. Regenerate with the statistics
  environment, then compile `compiler.c` yourself with `-O0 -DTSAOT_RT_STATS -include
  benchmarks/typescript_native/host.h` plus the mimalloc flags, link it against a `-DTSAOT_RT_STATS`
  runtime and the regexp/unicode objects of a complete build (set `ROOT` before sourcing
  `scripts/lib/regexp_link_flags.sh`), and run one `--noEmit` compile with `TSAOT_RT_STATS_FILE`.
  The dump lists the 400 hottest sites; `sites.json` of the matching build maps site ids to
  source spans and kinds (`cell` = scope record, `closure`, `array`, `object`).
- **The native build scripts build parallel units by default (Session 352,
  `docs/build_split_design.md`):** they write `units/` instead of `tsc-ts.c`/`compiler.c` and cache
  objects in `build/unit-cache` by content (the unit, the preprocessed header with its macros, the
  command). `TSAOT_NATIVE_UNITS=0` builds the one file (the statistics build above needs it). Compare
  like with like in an A/B: a units build (ThinLTO) is 1-4% faster than a one-file build of the
  same source.

## 8. 30-second summary (the shortest single-bug fix)

1. Read the tail of `docs/TODO.md`.
2. Compare node (V8) and garnet output with a bash probe → minimally reproduce the DIFF.
3. Make a targeted fix in `runtime/ts_rt.c` or `exporter/exporter.ts` (verify with generated C / lldb / RT_STATS / temporary instrumentation).
4. Add a regression test to `tests/conformance/exhaustive/…`.
5. Depending on the kind of change, run `scripts/gate.sh conf all` + unit (+ gc / bundler / selfconf / emitc_diff).
6. Append a session note to the end of `docs/TODO.md`. Commit on the user's instruction (English, with a `Verified:` line).

### Gotcha: the regexp adapter object is cached by presence, not by mtime

`tsaot_prepare_regexp_objs` (`scripts/lib/regexp_link_flags.sh`) compiles
`runtime/regexp/ts_regexp_adapter.c` into `$work/regexp/ts_regexp_adapter.o`
only when that file is missing. After editing the adapter, delete the cached
objects (`find build -name ts_regexp_adapter.o -not -path '*/native_s350*'
-delete`) before `dt`, the conformance gate or a relink, or the old adapter
is linked silently. A relink that copies a previous build's `regexp/`
directory needs the same deletion (see `docs/regexp_first_char_prefilter_design.md`).

### Gotcha: a new `TS_RT_ALWAYS_INLINE` helper must be allowlisted

`tests/runtime_inline_policy_gate.sh` enumerates every always-inline
helper in `runtime/ts_rt.h` against a `case` allowlist. A new one fails
it with "unexpected always-inline runtime helper"; the **unit** gate and
the **gc** gate both embed that check, so a `GC-STRESS FAILED` whose
sub-tests all passed is this (Session 350, x33). Add the name to the
allowlist in the same change.

### Gotcha: a cold-path edit can move a hot helper out of line

clang decides per build whether to inline a `static inline` helper, and
call sites added elsewhere, cold ones included, can flip that decision
inside a hot loop. GC v2 Y1 step 1b added six root visits and
`gc_visit_slot` became a call in `gc_scan_cell`: +1.1% instructions on the
compiler while the wall clock stayed within noise. Read the instruction
count of every A/B; when it moves on a change that should not touch the
hot path, compare the hot functions of the two runtimes (`objdump -d -r`
of each relinked `rt.o`, counting the `ARM64_RELOC_BRANCH26` calls per
function). Pin such a helper with `TS_RT_ALWAYS_INLINE` (in `ts_rt.c` the
header's allowlist does not apply).
