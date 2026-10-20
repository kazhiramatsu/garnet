#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/garnet-gc-adaptive-aging.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fixture="$ROOT/benchmarks/gc/gc_survivors.ts"

# Keep the ring-buffer site nursery-allocated so this gate measures the runtime
# lifetime policy rather than the independent AOT pretenuring optimization.
TSAOT_PRETENURE=0 \
  "$ROOT/garnet" --rt-stats -o "$work/survivors.c" "$fixture" >/dev/null 2>&1

# Aging is off by default (docs/gc_v2_design.md §6.5 step 2); threshold 2
# selects the adaptive policy this gate measures.
env \
  -u TSAOT_GC_AGING_ADAPTIVE \
  -u TSAOT_GC_YOUNG_THRESHOLD \
  -u TSAOT_GC_NURSERY_BYTES \
  -u TSAOT_GC_NURSERY \
  -u TSAOT_DISABLE_MOVING_MINOR \
  TSAOT_GC_AGE_THRESHOLD=2 \
  TSAOT_RT_STATS_FILE="$work/adaptive.stats" \
  ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=0}" \
  "$work/survivors" >"$work/adaptive.out"

env \
  -u TSAOT_GC_YOUNG_THRESHOLD \
  -u TSAOT_GC_NURSERY_BYTES \
  -u TSAOT_GC_NURSERY \
  -u TSAOT_DISABLE_MOVING_MINOR \
  TSAOT_GC_AGE_THRESHOLD=2 \
  TSAOT_GC_AGING_ADAPTIVE=0 \
  TSAOT_RT_STATS_FILE="$work/fixed.stats" \
  ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=0}" \
  "$work/survivors" >"$work/fixed.out"

env \
  -u TSAOT_GC_YOUNG_THRESHOLD \
  -u TSAOT_GC_NURSERY_BYTES \
  -u TSAOT_GC_NURSERY \
  -u TSAOT_DISABLE_MOVING_MINOR \
  TSAOT_GC_AGE_THRESHOLD=1 \
  TSAOT_RT_STATS_FILE="$work/immediate.stats" \
  ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=0}" \
  "$work/survivors" >"$work/immediate.out"

cmp -s "$work/adaptive.out" "$work/fixed.out" &&
  cmp -s "$work/adaptive.out" "$work/immediate.out" || {
    echo "[gc-adaptive-aging] FAIL: lifetime policy changed program output"
    exit 1
  }

adaptive_minor="$(sed -n 's/.*gc: minor=\([0-9][0-9]*\).*/\1/p' "$work/adaptive.stats")"
fixed_minor="$(sed -n 's/.*gc: minor=\([0-9][0-9]*\).*/\1/p' "$work/fixed.stats")"
activations="$(sed -n 's/.*aging:.*activations=\([0-9][0-9]*\).*/\1/p' "$work/adaptive.stats")"
fallback_minors="$(sed -n 's/.*aging:.*fallback_minors=\([0-9][0-9]*\).*/\1/p' "$work/adaptive.stats")"
copied_bytes="$(sed -n 's/.*aging: copied_bytes=\([0-9][0-9]*\).*/\1/p' "$work/adaptive.stats")"
immediate_copied="$(sed -n 's/.*aging: copied_bytes=\([0-9][0-9]*\).*/\1/p' "$work/immediate.stats")"

[[ "${adaptive_minor:-0}" -gt 0 &&
   "${fixed_minor:-0}" -gt "${adaptive_minor:-0}" ]] || {
  echo "[gc-adaptive-aging] FAIL: survivor residency still amplified minor collections"
  exit 1
}
[[ "${activations:-0}" -gt 0 &&
   "${fallback_minors:-0}" -gt 0 &&
   "${copied_bytes:-0}" -gt 0 ]] || {
  echo "[gc-adaptive-aging] FAIL: the adaptive policy did not age then fall back"
  exit 1
}
[[ "${immediate_copied:-0}" -eq 0 ]] || {
  echo "[gc-adaptive-aging] FAIL: threshold 1 did not restore immediate promotion"
  exit 1
}

echo "[gc-adaptive-aging] PASS: adaptive=${adaptive_minor} minors, fixed=${fixed_minor}, fallback=${fallback_minors}"
