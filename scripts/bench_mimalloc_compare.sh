#!/usr/bin/env bash
# Compare benchmark timings with the system allocator vs mimalloc.
#
# Usage:
#   bash scripts/bench_mimalloc_compare.sh 'kernel|gc_churn_kernel'
#
# Requires mimalloc to be installed or discoverable via:
#   TSAOT_MIMALLOC_PREFIX=/path/to/prefix
#   TSAOT_MIMALLOC_CFLAGS='-I...'
#   TSAOT_MIMALLOC_LIBS='-L... -lmimalloc'
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILTER="${1:-kernel}"
RUNS="${TSAOT_RUNS:-5}"

echo "=== baseline allocator ==="
TSAOT_RUNS="$RUNS" TSAOT_NO_BUDGET=1 bash "$ROOT/scripts/run_benchmarks.sh" "$FILTER"

echo
echo "=== mimalloc ==="
TSAOT_USE_MIMALLOC=1 TSAOT_RUNS="$RUNS" TSAOT_NO_BUDGET=1 bash "$ROOT/scripts/run_benchmarks.sh" "$FILTER"
