# tsaot CI — operating procedure

The CI is the regression safety net: it verifies the whole pipeline still
produces correct native code and that benchmark performance hasn't regressed.
Run it before and after any optimization.

## What CI checks (4 stages, `scripts/ci.sh`)
1. **Analyzer build** — `cargo build --release` of the Rust analyzer/codegen.
2. **Runtime unit tests** — compiles & runs `runtime/ts_rt_test.c` (NaN-boxing,
   object model, operators, GC; ~24 assertions).
3. **Analyzer unit-test suites** — 7 suites covering escape analysis (P1/P2/P3),
   closures, codegen strategy, class layout, and devirtualization.
4. **Benchmark correctness + time budget** — for each row in
   `benchmarks/manifest.tsv`: export TS→IR, analyze+emit C, gcc, run, assert
   stdout == expected (**correctness gate**) and wall-clock ≤ budget
   (**regression gate**).

Any failure makes the stage — and `ci.sh` — exit nonzero.

## One-time setup
```bash
# 1. Rust toolchain (cargo/rustc) and a C compiler (gcc) must be installed.
# 2. Node.js (v18+) for the exporter.
# 3. Install exporter dependencies (TypeScript):
cd tsaot/exporter && npm install      # creates node_modules/ with typescript
```

## Running CI
```bash
cd tsaot
bash scripts/ci.sh                     # full gate: build + runtime + unit + bench
```
Individual stages:
```bash
bash scripts/run_runtime_tests.sh      # runtime only
bash scripts/run_unit_tests.sh         # analyzer unit suites only
bash scripts/run_benchmarks.sh         # benchmarks only
```

### Useful environment knobs (benchmarks)
```bash
TSAOT_RUNS=5      bash scripts/run_benchmarks.sh   # more timed runs, take the min
TSAOT_NO_BUDGET=1 bash scripts/run_benchmarks.sh   # correctness only, skip timing
TSAOT_CC="gcc -O3 -march=native" bash scripts/run_benchmarks.sh   # custom compiler
TSAOT_RUNS=5      bash scripts/run_v8_benchmarks.sh 'string_.*_kernel' # warm V8 refs for exported JS kernels
```

## Interpreting benchmark output
```
BENCHMARK      RESULT     EXPECTED   TIME(ms)  BUDGET    STATUS
int_kernel     334269     334269     377       520       PASS
float_kernel   1.25e15... 1.25e15... 248       340       PASS
obj_kernel     701571     701571     996       1350      PASS
```
- **PASS** — output matches and time ≤ budget.
- **WRONG_OUTPUT** — native result ≠ expected: a *correctness* regression. The
  highest-severity failure; fix before anything else.
- **SLOW(>budget)** — correct but slower than budget: a *performance* regression.
- **EXPORT_FAIL / ANALYZE_FAIL / COMPILE_FAIL** — a stage of the pipeline broke;
  the stderr of that stage is printed inline.

## The benchmark manifest
`benchmarks/manifest.tsv` (tab-separated) is the source of truth:
```
# name        source           expected             aot_budget_ms  v8_ref_ms  verdict
int_kernel    int_kernel.ts    334269               520            519        AOT_WINS
float_kernel  float_kernel.ts  1250002487503344.2   340            244        TIE
obj_kernel    obj_kernel.ts    701571               1350           365        V8_WINS_known_gap
```
- `expected` is the exact first line of stdout the native binary must print.
- `aot_budget_ms` is the regression ceiling (set ~1.3x of the observed AOT time
  to tolerate noise while still catching real slowdowns).
- `v8_ref_ms` / `verdict` are documentation of the current standing vs V8; CI does
  not gate on them.

## Adding a new benchmark
1. Write `benchmarks/<name>.ts` (and an equivalent `<name>.js` for the V8 ref).
2. Run it once to capture the correct output and a baseline AOT time:
   ```bash
   cd exporter && node exporter.js ../benchmarks/<name>.ts /tmp/p.json /tmp/l.json
   ../analyzer/target/release/tsaot /tmp/p.json emit > /tmp/g.c
   gcc -O2 /tmp/g.c ../runtime/ts_rt.c -I../runtime -o /tmp/b && /tmp/b   # note output
   ```
3. Add a row to `manifest.tsv` with the captured output and a budget ≈1.3x the
   baseline time.
4. `bash scripts/ci.sh` to confirm green.

## Updating baselines after a (legitimate) speedup
When an optimization makes a benchmark faster, lower its `aot_budget_ms` so the
new floor is enforced. The CI self-tests its own gates: tightening a budget below
the real time yields `SLOW`, and changing `expected` yields `WRONG_OUTPUT` — both
exit nonzero, confirming the gates are live.

## Workflow for an optimization
```bash
bash scripts/ci.sh          # 1. green baseline
# ... make the change ...
bash scripts/ci.sh          # 2. still correct? faster? (watch TIME(ms))
# 3. if faster, tighten the relevant aot_budget_ms in manifest.tsv
bash scripts/ci.sh          # 4. confirm green at the new budget
```
