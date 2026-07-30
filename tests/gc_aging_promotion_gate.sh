#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/garnet-gc-aging.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fixture="$ROOT/tests/conformance/exhaustive/gc/promotion_barrier_aging.ts"

# Pretenuring and adaptive fallback are disabled deliberately: the regression
# requires fixed aging so a young parent promotes before its younger child.
TSAOT_PRETENURE=0 \
TSAOT_GC_AGE_THRESHOLD=2 \
TSAOT_GC_AGING_ADAPTIVE=0 \
TSAOT_GC_YOUNG_THRESHOLD=16 \
  bash "$ROOT/scripts/run_conformance.sh" exhaustive '^promotion_barrier_aging$'

TSAOT_PRETENURE=0 \
  "$ROOT/garnet" --rt-stats -o "$work/promotion.c" "$fixture" >/dev/null 2>&1
TSAOT_GC_AGE_THRESHOLD=2 \
TSAOT_GC_AGING_ADAPTIVE=0 \
TSAOT_GC_YOUNG_THRESHOLD=16 \
TSAOT_RT_STATS_FILE="$work/stats" \
ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=0}" \
  "$work/promotion" >"$work/output"

grep -q '^parent 41 true$' "$work/output" || {
  echo "[gc-aging] FAIL: promotion-barrier output changed"
  exit 1
}
minor="$(sed -n 's/.*gc: minor=\([0-9][0-9]*\).*/\1/p' "$work/stats")"
aged_arena="$(sed -n 's/.*nursery:.*aged=\([0-9][0-9]*\)+.*/\1/p' "$work/stats")"
aged_unpooled="$(sed -n 's/.*nursery:.*aged=[0-9][0-9]*+\([0-9][0-9]*\).*/\1/p' "$work/stats")"
[[ "${minor:-0}" -ge 3 && $(( ${aged_arena:-0} + ${aged_unpooled:-0} )) -gt 0 ]] || {
  echo "[gc-aging] FAIL: regression fixture did not exercise at least three aging minors"
  exit 1
}

echo "[gc-aging] PASS: promotion-created old-to-young edges remain remembered"
