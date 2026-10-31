#!/usr/bin/env bash
# test262 through the conformance runner, directory by directory: compose the cases, compile each in untyped
# mode (a test is plain JavaScript: no annotation to trust) at -O1, compare with V8. Every chunk's log stays
# under build/test262_out; a chunk with a log is skipped, so a stopped run resumes (delete the logs to redo).
#   scripts/test262/run.sh [subpath...]     default: all of test/, split at the second level
# TSAOT_CONF_JOBS (default 3), TSAOT_CONF_TIMEOUT (default 20 s), TSAOT_T262_SRC (default build/test262_src).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${TSAOT_T262_SRC:-$ROOT/build/test262_src}"
OUT="$ROOT/build/test262_out"; GEN="$ROOT/build/test262_gen"
mkdir -p "$OUT"
export TSAOT_CC="${TSAOT_CC:-cc -O1}"
RT_OBJ="$OUT/rt.o"
$TSAOT_CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$RT_OBJ" || exit 1
if [[ $# -gt 0 ]]; then chunks=("$@"); else
  chunks=()
  for top in language built-ins annexB staging intl402; do
    for d in "$SRC/test/$top"/*; do chunks+=("${d#$SRC/test/}"); done
  done
fi
for c in "${chunks[@]}"; do
  name="${c//\//__}"
  [[ -s "$OUT/$name.log" ]] && continue
  rm -rf "${GEN:?}/${name:?}"
  node "$ROOT/scripts/test262/gen.mjs" "$SRC" "$GEN/$name" "$c" > "$OUT/$name.gen" 2>&1 || { echo "[test262] gen failed: $c"; continue; }
  cp "$GEN/$name/META.tsv" "$OUT/$name.meta"
  t0=$(date +%s)
  TSAOT_CONF_DIR="$GEN/$name" TSAOT_CONF_VERBOSE=1 TSAOT_CONF_RT_OBJ="$RT_OBJ" TSAOT_UNTYPED=1 TSAOT_CONF_ORACLE_ESNEXT=1 \
    TSAOT_CONF_TIMEOUT="${TSAOT_CONF_TIMEOUT:-20}" TSAOT_CONF_JOBS="${TSAOT_CONF_JOBS:-3}" \
    nice -n 12 bash "$ROOT/scripts/run_conformance.sh" dir > "$OUT/$name.log" 2>&1
  echo "[test262] $c: $(wc -l < "$GEN/$name/META.tsv") cases in $(( $(date +%s) - t0 )) s: $(tail -1 "$OUT/$name.log" | cut -c1-60)"
  rm -rf "${GEN:?}/${name:?}"
done
python3 "$ROOT/scripts/test262/summary.py" "$OUT" --top 40 > "$OUT/SUMMARY.txt"
head -1 "$OUT/SUMMARY.txt"
