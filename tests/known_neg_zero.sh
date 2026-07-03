#!/bin/bash
# Runtime-arithmetic -0 is no longer a known divergent behavior. This smoke test
# stays in ci_fast/ci_par so regressions in the int-specialization boundary are
# caught even before the full conformance suite runs.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>/dev/null

check() {
  echo "$2" > "$tmp/t.ts"
  if ! node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null >/dev/null; then
    echo "[negzero] FAIL: $1 unexpectedly rejected"; fail=1; return
  fi
  analyzer/target/release/tsaot "$tmp/t.json" emit > "$tmp/t.c" 2>/dev/null
  $CC "$tmp/t.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/t" 2>/dev/null
  got=$("$tmp/t" 2>&1 | tr '\n' '|')
  if [ "$got" != "$3" ]; then
    echo "[negzero] FAIL: $1 got '$got' expected '$3'"; fail=1
  fi
}

check "Object.is(-zeroVar, -0)"  'function main(){ let z = 0; console.log(Object.is(-z, -0)); } main();' "true|"
check "0*y (y var) sign"         'function main(){ let y = -1; console.log(1 / (0 * y)); } main();' "-Infinity|"
check "negative integral modulo" 'function main(){ let x = -4; let y = 2; console.log(Object.is(x % y, -0)); } main();' "true|"

[ $fail -eq 0 ] && echo "[negzero] PASS: runtime arithmetic preserves -0 across int-specialization boundaries"
exit $fail
