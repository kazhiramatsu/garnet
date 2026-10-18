#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/garnet-mi-static.XXXXXX")"
trap 'rm -rf "$work"' EXIT

cat > "$work/probe.c" <<'EOF'
#include <mimalloc.h>
int main(void) {
  void* p = mi_malloc(16);
  mi_free(p);
  return 0;
}
EOF

probe_cc="${TSAOT_CC:-cc -O2}"
CC="$probe_cc"
TSAOT_LDLIBS=""
TSAOT_USE_MIMALLOC=1
unset TSAOT_MIMALLOC_PREFIX TSAOT_MIMALLOC_CFLAGS TSAOT_MIMALLOC_LIBS
unset TSAOT_MIMALLOC_DEBUG
export ROOT CC TSAOT_LDLIBS TSAOT_USE_MIMALLOC
. "$ROOT/scripts/lib/mimalloc_flags.sh"

[[ "${TSAOT_MIMALLOC_ACTIVE:-0}" == "1" ]]
[[ "${TSAOT_MIMALLOC_VENDOR_ACTIVE:-0}" == "1" ]]
[[ "$TSAOT_LDLIBS" == *"$ROOT/build/mimalloc/mimalloc-"*".o"* ]]
[[ "$TSAOT_LDLIBS" != *"-lmimalloc"* ]]

# shellcheck disable=SC2086
$CC "$work/probe.c" $TSAOT_LDLIBS -o "$work/probe"
MIMALLOC_VERBOSE=1 "$work/probe" >"$work/probe.out" 2>"$work/probe.err"
grep -Eq 'debug level *: 0' "$work/probe.err" || {
  echo "[mimalloc-static] FAIL: default allocator still has debug checks enabled"
  exit 1
}

case "$(uname -s)" in
  Darwin)
    if otool -L "$work/probe" | grep -qi mimalloc; then
      echo "[mimalloc-static] FAIL: generated probe depends on a mimalloc dylib"
      exit 1
    fi
    ;;
  Linux)
    if readelf -d "$work/probe" 2>/dev/null | grep -qi 'NEEDED.*mimalloc'; then
      echo "[mimalloc-static] FAIL: generated probe depends on a mimalloc DSO"
      exit 1
    fi
    ;;
esac

echo "[mimalloc-static] PASS: vendored source produced a static target object"
