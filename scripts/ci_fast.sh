#!/usr/bin/env bash
# tsaot CI stage 1 (fast): build + runtime/analyzer unit tests + negative tests.
# Skips the (slow) benchmark suite — run scripts/ci_bench.sh for that.
# Forced-GC gates are opt-in with TSAOT_CI_GC_STRESS=1.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/scripts"
rc=0
echo "=== tsaot CI [fast: build + unit + negative] ==="
echo ">>> build analyzer (release)"
(cd "$ROOT/analyzer" && cargo build --release --quiet) || { echo "analyzer build FAILED"; exit 1; }
echo ">>> runtime unit tests";  bash "$S/run_runtime_tests.sh" || rc=1
echo ">>> static mimalloc link flags"; bash "$ROOT/tests/mimalloc_static_link_gate.sh" || rc=1
echo ">>> analyzer unit-test suites"; bash "$S/run_unit_tests.sh" || rc=1
# exporter build (needed by negative tests)
if [[ -d "$ROOT/exporter/node_modules" ]]; then
  (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
     --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) \
     || { echo "exporter build FAILED"; rc=1; }
fi
echo ">>> IR wire conversion"; node "$ROOT/tests/wire_program_tests.js" || rc=1
echo ">>> production optimization defaults"; bash "$ROOT/tests/default_optimizations_gate.sh" || rc=1
echo ">>> project compiler options"; bash "$ROOT/tests/project_options_gate.sh" || rc=1
if [[ "${TSAOT_CI_GC_STRESS:-0}" == "1" ]]; then
  echo ">>> escape-guided pretenuring"; bash "$ROOT/tests/pretenure_aot_gate.sh" || rc=1
fi
echo ">>> golden iteration tests"
bash "$ROOT/scripts/run_golden_iter.sh" || rc=1
echo ">>> fetch / HTTPS transport (compile+link)"
bash "$ROOT/scripts/run_fetch_test.sh" || rc=1
echo ">>> negative tests"
bash "$ROOT/tests/rejects_async.sh" || rc=1
bash "$ROOT/tests/rejects_unsupported_stdlib.sh" || rc=1
bash "$ROOT/tests/rejects_bigint_etc.sh" || rc=1
bash "$ROOT/tests/rejects_symbol.sh" || rc=1
bash "$ROOT/tests/known_neg_zero.sh" || rc=1
bash "$ROOT/tests/string_concat_aot_gate.sh" || rc=1
bash "$ROOT/tests/jsx_aot_gate.sh" || rc=1
bash "$ROOT/tests/runtime_anymethod_safe.sh" || rc=1
bash "$ROOT/tests/regexp_classifier.sh" || rc=1
bash "$ROOT/tests/regexp_aot_gate.sh" || rc=1
bash "$ROOT/tests/regexp_link_gate.sh" || rc=1
bash "$ROOT/tests/unicode_aot_gate.sh" || rc=1
bash "$ROOT/tests/unicode_link_gate.sh" || rc=1
bash "$ROOT/tests/fetch_aot_gate.sh" || rc=1
bash "$ROOT/tests/json_dom_iter_free_gate.sh" || rc=1
bash "$ROOT/tests/strict_type_optimizations_gate.sh" || rc=1
bash "$ROOT/tests/strict_generic_inference_gate.sh" || rc=1
bash "$ROOT/tests/strict_type_spec_specialization_gate.sh" || rc=1
bash "$ROOT/tests/strict_explicit_specialization_gate.sh" || rc=1
bash "$ROOT/tests/rejects_syntax.sh" || rc=1
if [[ $rc -eq 0 ]]; then echo " CI-FAST PASSED"; else echo " CI-FAST FAILED"; fi
exit $rc
