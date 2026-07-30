#!/usr/bin/env bash
# Compare benchmark timings with the system allocator vs mimalloc.
#
# Usage:
#   bash scripts/bench_mimalloc_compare.sh 'kernel|gc_churn_kernel'
#
# Uses the repository-owned mimalloc source by default. An external build can be
# selected for comparison via TSAOT_MIMALLOC_PREFIX or the expert
# TSAOT_MIMALLOC_CFLAGS/TSAOT_MIMALLOC_LIBS overrides.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILTER="${1:-kernel}"
RUNS="${TSAOT_RUNS:-5}"

echo "=== baseline allocator ==="
TSAOT_RUNS="$RUNS" TSAOT_NO_BUDGET=1 bash "$ROOT/scripts/run_benchmarks.sh" "$FILTER"

echo
echo "=== mimalloc ==="
TSAOT_USE_MIMALLOC=1 TSAOT_RUNS="$RUNS" TSAOT_NO_BUDGET=1 bash "$ROOT/scripts/run_benchmarks.sh" "$FILTER"
