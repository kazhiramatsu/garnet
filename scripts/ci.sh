#!/usr/bin/env bash
# tsaot CI gate: runtime tests + analyzer unit tests + benchmark correctness/perf.
# Exits nonzero if any stage fails. Run from anywhere.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/scripts"
rc=0

echo "============================================================"
echo " tsaot CI"
echo "============================================================"

echo; echo ">>> [1/4] build analyzer (release)"
(cd "$ROOT/analyzer" && cargo build --release --quiet) || { echo "analyzer build FAILED"; exit 1; }

echo; echo ">>> [2/4] runtime unit tests"
bash "$S/run_runtime_tests.sh" || rc=1

echo; echo ">>> [3/4] analyzer unit-test suites"
bash "$S/run_unit_tests.sh" || rc=1

echo; echo ">>> [4/4] benchmark correctness + time budget"
# build exporter if node_modules present; otherwise the bench script reports EXPORT_FAIL
if [[ -d "$ROOT/exporter/node_modules" ]]; then
  (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
     --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) \
     || { echo "exporter build FAILED"; rc=1; }
else
  echo "    (exporter/node_modules missing — run: cd exporter && npm install)"
fi
bash "$S/run_benchmarks.sh" || rc=1

echo; echo ">>> [extra] negative tests (unsupported constructs rejected, not miscompiled)"
bash "$ROOT/tests/rejects_async.sh" || rc=1
bash "$ROOT/tests/rejects_unsupported_stdlib.sh" || rc=1
bash "$ROOT/tests/rejects_bigint_etc.sh" || rc=1
bash "$ROOT/tests/rejects_syntax.sh" || rc=1

echo
echo "============================================================"
if [[ $rc -eq 0 ]]; then echo " CI PASSED"; else echo " CI FAILED"; fi
echo "============================================================"
exit $rc
