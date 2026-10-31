#!/usr/bin/env bash
# test262 through the conformance runner: compose the cases under test/<subpath>..., compile each in
# untyped mode (a test is plain JavaScript: no annotation to trust) at -O1, and compare with V8.
#   scripts/test262/run.sh <name> <subpath>...     writes build/test262_out/<name>.log and its summary
# TSAOT_CONF_JOBS (default 3), TSAOT_T262_SRC (default build/test262_src, a clone of tc39/test262).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name=$1; shift
SRC="${TSAOT_T262_SRC:-$ROOT/build/test262_src}"
GEN="$ROOT/build/test262_gen/$name"; OUT="$ROOT/build/test262_out"
mkdir -p "$OUT"; rm -rf "$GEN"
node "$ROOT/scripts/test262/gen.mjs" "$SRC" "$GEN" "$@" | tee "$OUT/$name.gen"
TSAOT_CONF_DIR="$GEN" TSAOT_UNTYPED=1 TSAOT_CC="${TSAOT_CC:-cc -O1}" TSAOT_CONF_TIMEOUT="${TSAOT_CONF_TIMEOUT:-20}" \
  TSAOT_CONF_JOBS="${TSAOT_CONF_JOBS:-3}" nice -n 12 bash "$ROOT/scripts/run_conformance.sh" dir > "$OUT/$name.log" 2>&1
python3 "$ROOT/scripts/test262/summary.py" "$OUT/$name.log" --top 30 | tee "$OUT/$name.summary"
