#!/usr/bin/env bash
# CI bench shard 1: correctness for stdlib/syntax/class/generics (no timing gate).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rc=0
echo "=== tsaot CI [bench-correct-1: stdlib/syntax/class/generics] ==="
[[ -x "$ROOT/analyzer/target/release/tsaot" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet) || { echo "analyzer build FAILED"; exit 1; }
[[ -f "$ROOT/exporter/exporter.js" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) || rc=1
# everything that is NOT a kernel and NOT a coroutine/iterator test
TSAOT_NO_BUDGET=1 bash "$ROOT/scripts/run_benchmarks.sh" '^(sroa|syntax|escaping|dynamic|proto|generic_fn$|generic_class|generic_multi|generic_inherit|inherited|inherit_chain|inherit_sroa_3|inline_|typed_field_param|stdlib|mapset|closure|math_|date_|json_|b3b|exceptions)' || rc=1
[[ $rc -eq 0 ]] && echo " CI-BENCH-CORRECT-1 PASSED" || echo " CI-BENCH-CORRECT-1 FAILED"
exit $rc
