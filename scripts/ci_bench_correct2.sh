#!/usr/bin/env bash
# CI bench shard 2: correctness for async/generators/iterators (no timing gate).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rc=0
echo "=== tsaot CI [bench-correct-2: async/gen/iterator] ==="
[[ -x "$ROOT/analyzer/target/release/tsaot" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet) || { echo "analyzer build FAILED"; exit 1; }
[[ -f "$ROOT/exporter/exporter.js" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) || rc=1
TSAOT_NO_BUDGET=1 bash "$ROOT/scripts/run_benchmarks.sh" '^(async|generators|gen_loop|await_loop|coro|forof|finally|yield|custom|iterator_close)' || rc=1
[[ $rc -eq 0 ]] && echo " CI-BENCH-CORRECT-2 PASSED" || echo " CI-BENCH-CORRECT-2 FAILED"
exit $rc
