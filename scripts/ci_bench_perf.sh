#!/usr/bin/env bash
# CI bench shard: performance kernels (timed, budget-gated). ~7 benchmarks.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rc=0
echo "=== tsaot CI [bench-perf: timed kernels] ==="
[[ -x "$ROOT/analyzer/target/release/tsaot" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet) || { echo "analyzer build FAILED"; exit 1; }
[[ -f "$ROOT/exporter/exporter.js" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) || rc=1
bash "$ROOT/scripts/run_benchmarks.sh" 'kernel' || rc=1
[[ $rc -eq 0 ]] && echo " CI-BENCH-PERF PASSED" || echo " CI-BENCH-PERF FAILED"
exit $rc
