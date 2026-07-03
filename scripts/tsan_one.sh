#!/bin/bash
# Run ONE conformance fixture (or any .ts file) through the self-hosting TS
# analyzer pipeline and diff against the node ESM oracle. Debug companion to
# analyzer_conformance.sh (same flow, verbose, keeps artifacts in /tmp/tsan1).
#   usage: scripts/tsan_one.sh tests/conformance/exhaustive/iteration/custom_iterable.ts
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-cc -O2}"
ts="$1"
tmp=/tmp/tsan1; mkdir -p "$tmp"
export ROOT CC
. "$ROOT/scripts/lib/mimalloc_flags.sh" 2>/dev/null || true
. "$ROOT/scripts/lib/regexp_link_flags.sh" || exit 1
[ -f "$tmp/rt.o" ] || $CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$tmp/rt.o" || exit 1

TSAOT_UNTYPED=1 node "$ROOT/exporter/exporter.js" "$ts" "$tmp/ir.json" "$tmp/l.json" >/dev/null || { echo "EXPORTER-FAIL"; exit 2; }
if ! node "$ROOT/analyzer_ts/dist/main.js" "$tmp/ir.json" emit > "$tmp/ts.c" 2>"$tmp/ts.err"; then
  cat "$tmp/ts.err"; exit 3
fi
tsaot_prepare_regexp_objs "$tmp/ts.c" "$tmp" >/dev/null 2>&1
tsaot_prepare_unicode_objs "$tmp/ts.c" "$tmp" >/dev/null 2>&1
tsaot_prepare_fetch_runtime "$tmp/ts.c" "$tmp" "$tmp/rt.o" >/dev/null 2>&1
# shellcheck disable=SC2086
$CC "$tmp/ts.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS \
  -I"$ROOT/runtime" -lm $TSAOT_FETCH_LDLIBS ${TSAOT_LDLIBS:-} -o "$tmp/ts.bin" 2>"$tmp/cc.err" \
  || { echo "CCFAIL:"; grep -m5 error "$tmp/cc.err"; exit 4; }
NODE_PATH="$ROOT/exporter/node_modules" node "$ROOT/scripts/_oracle_transpile.js" "$ts" "$tmp/oracle.mjs" 2>/dev/null || { echo "ORACLE-FAIL"; exit 5; }
oracle=$(node "$tmp/oracle.mjs" 2>&1)
got=$("$tmp/ts.bin" 2>&1)
if [ "$got" = "$oracle" ]; then
  echo "PASS"
else
  echo "DIFF:"
  echo "--- node oracle ---"; printf '%s\n' "$oracle"
  echo "--- ts.bin ---"; printf '%s\n' "$got"
  exit 1
fi
