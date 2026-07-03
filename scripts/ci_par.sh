#!/usr/bin/env bash
# tsaot parallel CI gate. Builds analyzer+exporter ONCE, runs all correctness
# gates concurrently (each gate is self-isolated via mktemp, so they don't clash),
# then runs the timed perf benchmarks ALONE (concurrent CPU load would inflate the
# budgets). Equivalent coverage to: conformance basic+exhaustive, focused moving
# GC stress, ci_fast (unit + runtime + golden + fetch + negative), bench-correct
# 1&2, bench-perf.
#
# Usage: bash scripts/ci_par.sh   (exit 0 = all green)
# Optional: TSAOT_CI_GC_STRESS_FORCED_MOVING=1 adds a forced Promise+Coro
# moving-minor focused gate. Legacy alias: TSAOT_CI_GC_STRESS_MOVING=1.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/scripts"
LOG="$ROOT/build/cilogs"
rm -rf "$LOG"; mkdir -p "$LOG"

echo "=== tsaot CI (parallel) ==="

# --- 1. build once so parallel gates don't contend on cargo/tsc. The analyzer
#        (cargo) and exporter (tsc) builds are independent, so run them together.
echo ">>> build analyzer (release) + exporter (concurrent)"
( cd "$ROOT/analyzer" && cargo build --release --quiet; echo $? >"$LOG/build_analyzer.rc" ) &
if [[ -d "$ROOT/exporter/node_modules" ]]; then
  ( cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
       --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop; \
    echo $? >"$LOG/build_exporter.rc" ) &
else
  echo 0 >"$LOG/build_exporter.rc"
fi
wait
if [[ "$(cat "$LOG/build_analyzer.rc" 2>/dev/null)" != "0" ]]; then echo "analyzer build FAILED"; exit 1; fi
if [[ "$(cat "$LOG/build_exporter.rc" 2>/dev/null)" != "0" ]]; then echo "exporter build FAILED"; exit 1; fi

# --- 2. correctness gates in parallel ------------------------------------------
# Each job: run a command, capture stdout/stderr to a log and its rc to a file.
# (Build artifacts already exist, so the gates' internal rebuild guards no-op;
#  every gate isolates its scratch files under its own mktemp dir.)
NAMES=""
run() {  # run <name> <cmd...>
  local name="$1"; shift
  NAMES="$NAMES $name"
  ( "$@" >"$LOG/$name.log" 2>&1; echo $? >"$LOG/$name.rc" ) &
}
negatives() {  # the negative + golden + fetch + runtime/unit suite (ci_fast minus rebuild)
  local rc=0
  bash "$S/run_runtime_tests.sh"            || rc=1
  bash "$S/run_unit_tests.sh"               || rc=1
  bash "$S/run_golden_iter.sh"              || rc=1
  bash "$S/run_fetch_test.sh"               || rc=1
  bash "$ROOT/tests/rejects_async.sh"             || rc=1
  bash "$ROOT/tests/rejects_unsupported_stdlib.sh"|| rc=1
  bash "$ROOT/tests/rejects_bigint_etc.sh"        || rc=1
  bash "$ROOT/tests/rejects_symbol.sh"            || rc=1
  bash "$ROOT/tests/known_neg_zero.sh"            || rc=1
  bash "$ROOT/tests/runtime_anymethod_safe.sh"    || rc=1
  bash "$ROOT/tests/rejects_syntax.sh"            || rc=1
  return $rc
}

echo ">>> running correctness gates in parallel"
run conf_exhaustive bash "$S/run_conformance.sh" exhaustive
run conf_basic      bash "$S/run_conformance.sh" basic
run gc_stress       bash "$S/run_gc_stress.sh"
RUN_FORCED_MOVING="${TSAOT_CI_GC_STRESS_FORCED_MOVING:-${TSAOT_CI_GC_STRESS_MOVING:-0}}"
if [[ "$RUN_FORCED_MOVING" != "0" ]]; then
  run gc_stress_forced env TSAOT_GC_STRESS_BASE=0 TSAOT_GC_STRESS_MOVE_BOTH=1 \
    bash "$S/run_gc_stress.sh"
fi
run fast            negatives
run bench_correct1  bash "$S/ci_bench_correct1.sh"
run bench_correct2  bash "$S/ci_bench_correct2.sh"
wait

# --- 3. perf alone (timed; no concurrent load) ---------------------------------
echo ">>> running perf benchmarks (isolated)"
run perf bash "$S/ci_bench_perf.sh"
wait

# --- 4. summary ----------------------------------------------------------------
echo "----------------------------------------"
rc=0
for name in $NAMES; do
  r="$(cat "$LOG/$name.rc" 2>/dev/null || echo 1)"
  if [[ "$r" == "0" ]]; then
    printf "  %-16s PASS\n" "$name"
  else
    printf "  %-16s FAIL (rc=%s)\n" "$name" "$r"; rc=1
  fi
done
echo "----------------------------------------"
if [[ $rc -ne 0 ]]; then
  echo "CI-PAR FAILED — failing gate logs:"
  for name in $NAMES; do
    r="$(cat "$LOG/$name.rc" 2>/dev/null || echo 1)"
    [[ "$r" == "0" ]] || { echo "===== $name ====="; tail -25 "$LOG/$name.log"; }
  done
else
  # surface the headline pass lines for confidence
  grep -hE "PASS=|all benchmarks|PASSED|all unit-test" "$LOG"/*.log 2>/dev/null | sed 's/^/  /'
  echo "CI-PAR PASSED"
fi
exit $rc
