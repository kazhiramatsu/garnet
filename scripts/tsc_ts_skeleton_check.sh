#!/usr/bin/env bash
# The check of tsc-ts's files without function bodies (benchmarks/tsc_ts_native/patches,
# 0006-files-without-function-bodies): what the compiler reports must not depend on them.
#
#   scripts/tsc_ts_skeleton_check.sh <tsc-ts binary> [TypeScript checkout]
#
# 1. The cases of benchmarks/tsc_ts_native/tests/skeleton (two or three files each, with errors in
#    and outside the bodies): compiled on two checkers with every file parsed in full
#    (TSC_TS_SKELETON=0), with every body left out that may be (TSC_TS_SKELETON_BODY=1), and with
#    the checker's own parse made to disagree (TSC_TS_SKELETON_FAIL=1, which compiles again).
# 2. The TypeScript compiler project (default: build/typescript_603/source), where 69 of 78 files
#    stand in for themselves when every body is left out, under option sets that report hundreds
#    of diagnostics: in full, as the build does by default, and with every body left out.
#
# Each line names what the forced run did (the files parsed without bodies, the programs a checker
# built with a file in full, a compile started again). Prints SKELETON-CHECK PASSED when every
# output and exit status is the same; exit status 1 otherwise. The lib directory is TSC_TS_LIB_DIR,
# or the tsc-ts checkout's under build/.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -ge 1 ] || { echo "usage: $0 <tsc-ts binary> [TypeScript checkout]" >&2; exit 2; }
BIN=$1
TS=${2:-$ROOT/build/typescript_603/source}
if [ -z "${TSC_TS_LIB_DIR:-}" ]; then
  for d in "$ROOT"/build/tsc-ts/node_modules/@scriptc/cli-*/dist/lib/typescript/lib; do
    [ -d "$d" ] && export TSC_TS_LIB_DIR="$d"
  done
fi
[ -n "${TSC_TS_LIB_DIR:-}" ] || { echo "TSC_TS_LIB_DIR is not set and build/tsc-ts has no @scriptc package" >&2; exit 2; }
OUT=$(mktemp -d)
bad=0
# what the forced run did, from its timeline (`@<ms> <thread> <event>`)
did() {
  awk '$3 == "skeleton" { files++ } $3 == "full" && $4 == "program" { programs++ } $3 == "compiling" && $4 == "again" { again++ }
       END { if (!files && !again) { printf "nothing left out"; exit }
             printf "%d file(s) without bodies, %d program(s) with a file in full", files, programs
             if (again) printf ", compiled again in full" }'
}

FLAGS="--ignoreConfig --noEmit --pretty false --checkers 2 --target es2022 --module esnext --moduleResolution bundler --strict"
for d in "$ROOT"/benchmarks/tsc_ts_native/tests/skeleton/*/; do
  name=$(basename "$d")
  files=$(cd "$d" && ls *.ts | tr '\n' ' ')
  (cd "$d" && TSC_TS_SKELETON=0 "$BIN" $FLAGS $files > "$OUT/full" 2>&1; echo "rc=$?" >> "$OUT/full")
  (cd "$d" && TSC_TS_SKELETON_BODY=1 "$BIN" $FLAGS $files > "$OUT/forced" 2>&1; echo "rc=$?" >> "$OUT/forced")
  (cd "$d" && TSC_TS_SKELETON_BODY=1 TSC_TS_SKELETON_FAIL=1 "$BIN" $FLAGS $files > "$OUT/failed" 2>&1; echo "rc=$?" >> "$OUT/failed")
  what=$(cd "$d" && TSC_TS_SKELETON_BODY=1 TSC_TS_TIMELINE=1 "$BIN" $FLAGS $files 2>&1 >/dev/null | did)
  n=$(grep -c "error TS" "$OUT/full")
  verdict=same
  cmp -s "$OUT/full" "$OUT/forced" || { verdict="DIFFERENT (bodies left out)"; bad=1; diff "$OUT/full" "$OUT/forced" | head -8; }
  cmp -s "$OUT/full" "$OUT/failed" || { verdict="DIFFERENT (compiled again)"; bad=1; diff "$OUT/full" "$OUT/failed" | head -8; }
  echo "case $name: $n diagnostics, $verdict; $what"
done

if [ -f "$TS/src/compiler/tsconfig.json" ]; then
  COMMON="-p src/compiler/tsconfig.json --composite false --incremental false --declaration false --declarationMap false --emitDeclarationOnly false --isolatedDeclarations false --sourceMap false --pretty false --noEmit"
  project() { # <label> [flags...]
    local label=$1; shift
    (cd "$TS" && TSC_TS_SKELETON=0 "$BIN" $COMMON "$@" > "$OUT/full" 2>&1; echo "rc=$?" >> "$OUT/full")
    (cd "$TS" && "$BIN" $COMMON "$@" > "$OUT/default" 2>&1; echo "rc=$?" >> "$OUT/default")
    (cd "$TS" && TSC_TS_SKELETON_BODY=1 "$BIN" $COMMON "$@" > "$OUT/forced" 2>&1; echo "rc=$?" >> "$OUT/forced")
    local what; what=$(cd "$TS" && TSC_TS_SKELETON_BODY=1 TSC_TS_TIMELINE=1 "$BIN" $COMMON "$@" 2>&1 >/dev/null | did)
    local n; n=$(grep -c "error TS" "$OUT/full")
    local verdict=same
    cmp -s "$OUT/full" "$OUT/default" || { verdict="DIFFERENT (default)"; bad=1; diff "$OUT/full" "$OUT/default" | head -8; }
    cmp -s "$OUT/full" "$OUT/forced" || { verdict="DIFFERENT (bodies left out)"; bad=1; diff "$OUT/full" "$OUT/forced" | head -8; }
    echo "compiler project, $label: $n diagnostics, $verdict; $what"
  }
  project "its own options"
  project "noUncheckedIndexedAccess" --noUncheckedIndexedAccess
  project "exactOptionalPropertyTypes and others" --exactOptionalPropertyTypes --noPropertyAccessFromIndexSignature --noImplicitOverride
else
  echo "no TypeScript checkout at $TS: the compiler project is not checked"
fi
if [ $bad = 0 ]; then echo "SKELETON-CHECK PASSED"; else echo "SKELETON-CHECK FAILED"; fi
exit $bad
