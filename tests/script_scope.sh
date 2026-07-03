#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/mimalloc_flags.sh" || exit 1

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/script_scope.ts" <<'TS'
console.log(Array === globalThis.Array);
console.log(Object === globalThis.Object);
console.log(Promise === globalThis.Promise);

{
  const Array = 1;
  console.log(Array);
}
console.log(Array === globalThis.Array);

function f(): number {
  const Promise = 2;
  return Promise;
}
console.log(f());
console.log(Promise === globalThis.Promise);

let Map = 3;
console.log(Map);
console.log(globalThis.Map === Map);

console.log("__hoisted" in globalThis);
var __hoisted;

var __x = 10;
console.log(globalThis.__x);

var Array;
console.log(Array === globalThis.Array);

var Array = 123;
console.log(Array);
console.log(globalThis.Array);

var parseInt = function(_s: any, _radix?: any): number {
  return 77;
};
console.log(parseInt("10", 10));
console.log(globalThis.parseInt("10", 10));

function __scriptFn(): number {
  return 1;
}
console.log("__scriptFn" in globalThis);
console.log((globalThis as any).__scriptFn === __scriptFn);
(globalThis as any).__scriptFn = function(): number {
  return 2;
};
console.log(__scriptFn());

function __scriptMix(): number {
  return 1;
}
var __scriptMix;
console.log(typeof __scriptMix, __scriptMix());

function __scriptMix2(): number {
  return 1;
}
var __scriptMix2 = 4;
console.log(__scriptMix2);
console.log(globalThis.__scriptMix2);
TS

node exporter/exporter.js --script "$tmp/script_scope.ts" "$tmp/program.json" "$tmp/labels.json" >/dev/null
analyzer/target/release/tsaot "$tmp/program.json" emit > "$tmp/out.c"
$CC "$tmp/out.c" runtime/ts_rt.c -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/a.out"

actual="$("$tmp/a.out" | tr '\n' '|')"
expected='true|true|true|1|true|2|true|3|false|true|10|true|123|123|77|77|true|true|2|function 1|4|4|'

if [[ "$actual" != "$expected" ]]; then
  echo "[script-scope] FAIL"
  echo "  expected: $expected"
  echo "  actual:   $actual"
  exit 1
fi

echo "[script-scope] PASS"
