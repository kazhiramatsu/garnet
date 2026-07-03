#!/usr/bin/env bash
# One-shot environment setup for a freshly-extracted tsaot checkout.
# Builds everything the CI scripts and the diff harness need, all repo-relative.
# Run from anywhere:  bash scripts/setup.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
fail=0

echo "[setup] 1/4 exporter deps (npm install)…"
if [ ! -d exporter/node_modules ]; then
  (cd exporter && npm install --no-audit --no-fund) || { echo "[setup] npm install FAILED — check network settings (registry.npmjs.org must be allowed)"; fail=1; }
else
  echo "[setup]   node_modules already present, skipping."
fi

echo "[setup] 2/4 exporter build (tsc)…"
(cd exporter && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
   --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) \
   && [ -f exporter/exporter.js ] || { echo "[setup] exporter build FAILED"; fail=1; }

echo "[setup] 3/4 analyzer build (cargo build --release)…"
(cd analyzer && cargo build --release 2>&1 | grep -E "^error" && { echo "[setup] analyzer build had errors"; fail=1; } ; true)
[ -x analyzer/target/release/tsaot ] || { echo "[setup] analyzer binary missing"; fail=1; }

echo "[setup] 4/4 runtime precompile (gcc -c ts_rt.c -> build/rt.o)…"
mkdir -p build
$CC -c runtime/ts_rt.c -Iruntime -o build/rt.o 2>&1 | grep -i error && { echo "[setup] runtime compile FAILED"; fail=1; } ; true
[ -f build/rt.o ] || { echo "[setup] build/rt.o missing"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "[setup] DONE. Sanity: bash scripts/run_conformance.sh exhaustive | tail -1"
else
  echo "[setup] FINISHED WITH ERRORS — fix the above before proceeding."
fi
exit $fail
