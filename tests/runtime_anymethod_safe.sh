#!/bin/bash
# Dynamic method dispatch on non-plain-objects must be MEMORY-SAFE (no heap
# overflow). After the unified object model (U-2..U-5 + followon), any-typed
# Array AND Map/Set methods resolve correctly through their prototype chains.
# This guards both correctness and the absence of AddressSanitizer errors.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O0 -g -fsanitize=address}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>/dev/null
run() {
  echo "$1" > "$tmp/t.ts"
  node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null
  ./analyzer/target/release/tsaot "$tmp/t.json" emit > "$tmp/t.c" 2>/dev/null
  $CC "$tmp/t.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/t" 2>/dev/null
  "$tmp/t" 2>&1 || true
}
chk() { # $1 desc, $2 src, $3 expected first line
  local out; out=$(run "$2")
  if echo "$out" | grep -qiE "AddressSanitizer|heap-buffer-overflow"; then echo "[anymethod-safe] FAIL: $1 memory error"; fail=1
  elif [ "$(echo "$out" | head -1)" != "$3" ]; then echo "[anymethod-safe] FAIL: $1 got '$out' want '$3'"; fail=1; fi
}
chk "arr:any.join()"   'function main(): void { const a: any = [1,2,3]; console.log(a.join(",")); }' "1,2,3"
chk "map:any.get()"    'function main(): void { const m: any = new Map(); m.set("k",9); console.log(m.get("k")); }' "9"
chk "set:any.has()"    'function main(): void { const s: any = new Set(); s.add(3); console.log(s.has(3)); }' "true"
[ $fail -eq 0 ] && echo "[anymethod-safe] PASS: any-typed array/map/set methods resolve correctly (no overflow)"
exit $fail
