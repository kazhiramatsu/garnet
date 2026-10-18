#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/garnet-default-opts.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fixture="$ROOT/tests/conformance/exhaustive/object_methods/property_pic.ts"
out_c="$work/defaults.c"
stats="$work/runtime.stats"
build_log="$work/build.log"

# Remove every diagnostic fallback so this gate tests the public driver's
# production defaults rather than the invoking shell's A/B configuration.
runtime_gc_env=(-u TSAOT_GC_YOUNG_THRESHOLD)
if [[ "${TSAOT_CI_GC_STRESS:-0}" == "1" ]]; then
  runtime_gc_env=(TSAOT_GC_YOUNG_THRESHOLD=1)
fi
env \
  -u TSAOT_CC \
  -u TSAOT_ANALYZER \
  -u TSAOT_UNTYPED \
  -u TSAOT_PROP_PIC \
  -u TSAOT_FAST_EXCEPTIONS \
  -u TSAOT_FRAME_ROOTS \
  -u TSAOT_PRETENURE \
  -u TSAOT_USE_MIMALLOC \
  -u TSAOT_MIMALLOC_PREFIX \
  -u TSAOT_MIMALLOC_CFLAGS \
  -u TSAOT_MIMALLOC_LIBS \
  -u TSAOT_MIMALLOC_VENDOR_DIR \
  "$ROOT/garnet" --rt-stats -o "$out_c" "$fixture" >"$build_log" 2>&1

grep -q 'TS_PROP_IC_INIT' "$out_c" || {
  echo "[default-opts] FAIL: property PIC emission is not enabled by default"
  exit 1
}
grep -q 'ts_setjmp' "$out_c" || {
  echo "[default-opts] FAIL: exception save/restore helpers are not enabled by default"
  exit 1
}
grep -q 'ts_frame_push' "$out_c" || {
  echo "[default-opts] FAIL: batched GC root frames are not enabled by default"
  exit 1
}
grep -q '_pretenured' "$out_c" || {
  echo "[default-opts] FAIL: escape-guided pretenuring is not enabled by default"
  exit 1
}
grep -Fq '[mimalloc] enabled (vendored)' "$build_log" || {
  echo "[default-opts] FAIL: vendored mimalloc is not enabled by default"
  exit 1
}

env \
  -u TSAOT_DISABLE_MOVING_MINOR \
  -u TSAOT_GC_NURSERY \
  -u TSAOT_GC_MOVE_PROMISE \
  -u TSAOT_GC_MOVE_CORO \
  -u TSAOT_GC_AGE_THRESHOLD \
  -u TSAOT_GC_AGING_ADAPTIVE \
  -u TSAOT_GC_FULL_THRESHOLD_BYTES \
  -u TSAOT_GC_ZAP \
  "${runtime_gc_env[@]}" \
  TSAOT_RT_STATS_FILE="$stats" \
  "$work/defaults" >/dev/null

minor="$(sed -n 's/.*gc: minor=\([0-9][0-9]*\).*/\1/p' "$stats")"
nursery="$(sed -n 's/.*nursery: alloc=\([0-9][0-9]*\).*/\1/p' "$stats")"
frames="$(sed -n 's/.*root_frames: frame_push=\([0-9][0-9]*\).*/\1/p' "$stats")"
pic_hits="$(sed -n 's/.*prop_pic: get=[0-9][0-9]* hit=\([0-9][0-9]*\).*/\1/p' "$stats")"
pretenured="$(sed -n 's/.*pretenured=\([0-9][0-9]*\).*/\1/p' "$stats")"
aging_copied="$(sed -n 's/.*aging: copied_bytes=\([0-9][0-9]*\).*/\1/p' "$stats")"

if [[ "${TSAOT_CI_GC_STRESS:-0}" == "1" ]]; then
  [[ "${minor:-0}" -gt 0 ]] || {
    echo "[default-opts] FAIL: generational GC did not run a minor collection"
    exit 1
  }
  [[ "${aging_copied:-0}" -gt 0 ]] || {
    echo "[default-opts] FAIL: adaptive threshold-2 aging is not enabled by default"
    exit 1
  }
fi
[[ "${nursery:-0}" -gt 0 ]] || {
  echo "[default-opts] FAIL: bump-nursery allocation is not enabled by default"
  exit 1
}
[[ "${frames:-0}" -gt 0 ]] || {
  echo "[default-opts] FAIL: generated program did not use GC root frames"
  exit 1
}
[[ "${pic_hits:-0}" -gt 0 ]] || {
  echo "[default-opts] FAIL: generated program did not hit a property PIC"
  exit 1
}
[[ "${pretenured:-0}" -gt 0 ]] || {
  echo "[default-opts] FAIL: generated program did not allocate a pretenured cell"
  exit 1
}
echo "[default-opts] PASS: PIC, root frames, pretenuring, nursery, and mimalloc defaults are active (GC stress=${TSAOT_CI_GC_STRESS:-0})"
