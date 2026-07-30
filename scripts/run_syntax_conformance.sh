#!/usr/bin/env bash
# Focused comprehensive syntax suite: tsc legality, AST grammar coverage,
# V8-vs-AOT runtime behavior, and loud rejection of unsupported legal syntax.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSC="$ROOT/exporter/node_modules/.bin/tsc"

for file in "$ROOT"/tests/conformance/exhaustive/syntax/*.ts; do
  "$TSC" --noEmit --strict --target es2022 --lib es2023,dom --skipLibCheck "$file"
done
"$TSC" --noEmit --strict --target es2022 --module commonjs \
  --moduleResolution node --lib es2023,dom --skipLibCheck \
  "$ROOT/tests/conformance/static/syntax_ambient_declarations.d.ts"
"$TSC" --noEmit --strict --target es2022 --module nodenext \
  --moduleResolution nodenext --lib es2023,dom --skipLibCheck \
  "$ROOT/tests/conformance/static/syntax_import_type.d.ts"

node "$ROOT/scripts/check_conformance_syntax_coverage.js"
TSAOT_USE_MIMALLOC="${TSAOT_USE_MIMALLOC:-0}" \
  bash "$ROOT/scripts/run_conformance.sh" exhaustive '^syntax_'
bash "$ROOT/scripts/run_legal_syntax_rejects.sh"
