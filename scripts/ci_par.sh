#!/usr/bin/env bash
# tsaot bounded-parallel CI gate. Builds analyzer+exporter ONCE, runs ordinary
# correctness gates in waves of at most four jobs, then runs the allocation-heavy
# GC stress and timed perf phases ALONE. Keeping GC stress out of the parallel
# wave avoids oversubscribing the machine and also prevents concurrent duplicate
# aging/string stress runs.
#
# Equivalent coverage to: conformance basic+exhaustive, comprehensive TypeScript
# syntax legality/coverage/rejection, focused moving GC stress, ci_fast
# (unit + runtime + golden + fetch + negative), bench-correct 1&2, bench-perf.
#
# Usage: bash scripts/ci_par.sh   (exit 0 = all green)
# Optional: TSAOT_CI_GC_STRESS_FORCED_MOVING=1 adds a forced Promise+Coro
# moving-minor focused gate. Legacy alias: TSAOT_CI_GC_STRESS_MOVING=1.
# Optional: TSAOT_CI_RUST_JOBS=N controls Cargo/rustc parallelism (default 2).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/scripts"
LOG="$ROOT/build/cilogs"
rm -rf "$LOG"; mkdir -p "$LOG"
RUST_JOBS="${TSAOT_CI_RUST_JOBS:-2}"
[[ "$RUST_JOBS" =~ ^[1-9][0-9]*$ ]] || {
  echo "TSAOT_CI_RUST_JOBS must be a positive integer"; exit 2;
}
export CARGO_BUILD_JOBS="$RUST_JOBS"

echo "=== tsaot CI (parallel) ==="

# --- 1. Build once before parallel gates. Cargo is intentionally isolated from
# exporter/tsc and capped: simultaneous compiler frontends were causing high CPU
# and memory pressure without improving test coverage.
echo ">>> build analyzer (release, isolated, cargo jobs=$RUST_JOBS)"
( cd "$ROOT/analyzer" && cargo build --release --quiet; echo $? >"$LOG/build_analyzer.rc" )
if [[ "$(cat "$LOG/build_analyzer.rc" 2>/dev/null)" != "0" ]]; then echo "analyzer build FAILED"; exit 1; fi

echo ">>> build exporter (isolated)"
if [[ -d "$ROOT/exporter/node_modules" ]]; then
  ( cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
       --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop; \
    echo $? >"$LOG/build_exporter.rc" )
else
  echo 0 >"$LOG/build_exporter.rc"
fi
if [[ "$(cat "$LOG/build_exporter.rc" 2>/dev/null)" != "0" ]]; then echo "exporter build FAILED"; exit 1; fi

# --- 2. ordinary correctness gates (bounded parallel waves) --------------------
# Each job: run a command, capture stdout/stderr to a log and its rc to a file.
# (Build artifacts already exist, so the gates' internal rebuild guards no-op;
#  every gate isolates its scratch files under its own mktemp dir.)
NAMES=""
run() {  # run <name> <cmd...>
  local name="$1"; shift
  NAMES="$NAMES $name"
  ( "$@" >"$LOG/$name.log" 2>&1; echo $? >"$LOG/$name.rc" ) &
}
negatives() {  # negative + golden + fetch + runtime suite (ci_fast minus Rust/build)
  local rc=0
  bash "$S/run_runtime_tests.sh"            || rc=1
  bash "$ROOT/tests/mimalloc_static_link_gate.sh" || rc=1
  bash "$ROOT/tests/default_optimizations_gate.sh" || rc=1
  bash "$ROOT/tests/pretenure_aot_gate.sh" || rc=1
  # Aging/adaptive-aging are owned by the isolated GC phase below. Running them
  # here as well used to duplicate both gates concurrently.
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

echo ">>> running Rust unit build/tests (isolated, cargo jobs=$RUST_JOBS)"
run rust_unit bash "$S/run_unit_tests.sh"
wait

echo ">>> running correctness gates (wave 1, max 4 jobs)"
run conf_exhaustive bash "$S/run_conformance.sh" exhaustive
run conf_basic      bash "$S/run_conformance.sh" basic
run syntax          bash "$S/run_syntax_conformance.sh"
run fast            negatives
wait

echo ">>> running correctness gates (wave 2, max 2 jobs)"
run bench_correct1  bash "$S/ci_bench_correct1.sh"
run bench_correct2  bash "$S/ci_bench_correct2.sh"
wait

# --- 3. GC stress alone ---------------------------------------------------------
# Forced Promise+Coro moving is folded into this invocation. The former second
# run repeated aging, adaptive-aging, and the 64 MiB string scale gate.
echo ">>> running GC stress (isolated)"
RUN_FORCED_MOVING="${TSAOT_CI_GC_STRESS_FORCED_MOVING:-${TSAOT_CI_GC_STRESS_MOVING:-0}}"
run gc_stress env TSAOT_GC_STRESS_MOVE_BOTH="$RUN_FORCED_MOVING" \
  bash "$S/run_gc_stress.sh"
wait

# --- 4. perf alone (timed; no concurrent load) ---------------------------------
echo ">>> running perf benchmarks (isolated)"
run perf bash "$S/ci_bench_perf.sh"
wait

# --- 5. summary ----------------------------------------------------------------
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
