#!/bin/bash
set -e
cd "$(dirname "$0")/.."
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
check() { # $1 = description, $2 = ts source
  echo "$2" > "$tmp/t.ts"
  if node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null; then
    echo "[reject-misc] FAIL: $1 accepted"; fail=1
  fi
}
check "BigInt literal"        'function main(): void { const x = 123n; console.log(x > 0n ? 1 : 0); }'
# new Date(number) and the component form + get*/getUTC*/toISOString are now
# implemented; string parsing and locale-formatting methods remain unsupported.
check "new Date(string)"      'function main(): void { const d = new Date("2020-01-01"); console.log(d.getTime()); }'
check "unsupported Date method" 'function main(): void { const d = new Date(2020,0,1); console.log(d.toLocaleDateString()); }'
check "unsupported Math fn"   'function main(): void { console.log(Math.sumPrecise([1, 2])); }'
# Note: all Object.defineProperty descriptor forms we model — data attributes
# (enumerable/writable/configurable incl. false), accessor function-value AND
# method-shorthand, enumerable accessors, getOwnPropertyDescriptor[s], and
# defineProperties — are now SUPPORTED. The only remaining defineProperty rejects
# are semantically-mandatory ones (value + get/set together, non-literal
# descriptor / attribute values), which are validated elsewhere.
[ $fail -eq 0 ] && echo "[reject-misc] PASS: BigInt / Date-args / unsupported namespace methods rejected"
exit $fail
