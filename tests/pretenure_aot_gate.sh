#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/garnet-pretenure.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fixture="$ROOT/tests/conformance/exhaustive/gc/pretenure_escape.ts"
analyzer="$ROOT/analyzer/target/release/tsaot"
exporter="$ROOT/exporter/exporter.js"
default_c="$work/default.c"
disabled_c="$work/disabled.c"
stats="$work/runtime.stats"
disabled_stats="$work/disabled.stats"
build_log="$work/build.log"

env \
  -u TSAOT_CC \
  -u TSAOT_ANALYZER \
  -u TSAOT_UNTYPED \
  -u TSAOT_PRETENURE \
  -u TSAOT_USE_MIMALLOC \
  "$ROOT/garnet" --rt-stats -o "$default_c" "$fixture" >"$build_log" 2>&1

grep -q '_pretenured' "$default_c" || {
  echo "[pretenure] FAIL: escape-proven module allocations were not pretenured"
  exit 1
}
grep -q 'ts_new_object();' "$default_c" || {
  echo "[pretenure] FAIL: repeatable/non-global sites were all pretenured"
  exit 1
}

# Exercise the lifetime classifier on production benchmark IR. The unbounded
# retained chain should bypass the nursery; indexed replacement in a bounded
# ring buffer must remain a normal allocation.
node "$exporter" "$ROOT/benchmarks/gc/gc_deep_chain.ts" \
  "$work/deep.json" "$work/deep.labels.json" >/dev/null
TSAOT_PRETENURE=1 "$analyzer" "$work/deep.json" report >"$work/deep.report"
grep -q '"site":0,"state":"noEscape","strategy":"pretenuredHeap"' "$work/deep.report" || {
  echo "[pretenure] FAIL: retained loop-carried chain was not preclassified"
  exit 1
}

node "$exporter" "$ROOT/benchmarks/gc/gc_survivors.ts" \
  "$work/ring.json" "$work/ring.labels.json" >/dev/null
TSAOT_PRETENURE=1 "$analyzer" "$work/ring.json" report >"$work/ring.report"
if grep -q '"site":0,"state":"noEscape","strategy":"pretenuredHeap"' "$work/ring.report"; then
  echo "[pretenure] FAIL: bounded ring-buffer allocation was over-pretenured"
  exit 1
fi

TSAOT_PRETENURE=0 "$ROOT/garnet" --rt-stats -o "$disabled_c" "$fixture" >/dev/null 2>&1
if grep -q '_pretenured' "$disabled_c"; then
  echo "[pretenure] FAIL: TSAOT_PRETENURE=0 did not restore nursery allocation"
  exit 1
fi

TSAOT_GC_YOUNG_THRESHOLD=1 \
TSAOT_RT_STATS_FILE="$stats" \
  "$work/default" >"$work/output"
TSAOT_GC_YOUNG_THRESHOLD=1 \
TSAOT_RT_STATS_FILE="$disabled_stats" \
  "$work/disabled" >"$work/disabled.output"

grep -q '^41 1,2,3 7 1999000$' "$work/output" || {
  echo "[pretenure] FAIL: generated program output changed"
  exit 1
}
cmp -s "$work/output" "$work/disabled.output" || {
  echo "[pretenure] FAIL: pretenured and nursery modes produced different output"
  exit 1
}
pretenured="$(sed -n 's/.*pretenured=\([0-9][0-9]*\).*/\1/p' "$stats")"
disabled_pretenured="$(sed -n 's/.*pretenured=\([0-9][0-9]*\).*/\1/p' "$disabled_stats")"
[[ "${pretenured:-0}" -gt 0 ]] || {
  echo "[pretenure] FAIL: runtime observed no old-generation direct allocations"
  exit 1
}
[[ "${disabled_pretenured:-0}" -eq 0 ]] || {
  echo "[pretenure] FAIL: disabled runtime still observed pretenured allocations"
  exit 1
}

echo "[pretenure] PASS: module roots and retained chains pretenure without ring-buffer overclassification"
