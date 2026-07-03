#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/mimalloc_flags.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

TSAOT="$ROOT/analyzer/target/release/tsaot"
EXPORTER="$ROOT/exporter/exporter.js"
[[ -x "$TSAOT" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet)
[[ -f "$EXPORTER" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)

check_json() {
  local file="$1"
  local expr="$2"
  local label="$3"
  if ! node -e "const p=require(process.argv[1]); if (!($expr)) process.exit(1)" "$file"; then
    echo "[strict-type-spec] FAIL: $label"
    exit 1
  fi
}

cat > "$tmp/string_specialize.ts" <<'TS'
function slen<T extends string>(s: T): number { return s.length; }
function findB<T extends string>(s: T): number { return s.indexOf("b"); }
function passthrough<T>(x: T): T { return x; }
function main(): void {
  console.log(slen("abc"));
  console.log(findB("abc"));
  console.log(passthrough("x"));
}
main();
TS

node exporter/exporter.js "$tmp/string_specialize.ts" "$tmp/default.json" "$tmp/default.labels.json" >/dev/null 2>"$tmp/default.err"
check_json "$tmp/default.json" \
  'p.strictTypeOptimizations.enabled === false && !p.functions.some(f => f.name === "slen$string" || f.name === "findB$string" || f.name === "passthrough$string")' \
  "default exporter must not create strict string generic specializations"

node exporter/exporter.js --strict "$tmp/string_specialize.ts" "$tmp/strict.json" "$tmp/strict.labels.json" >/dev/null 2>"$tmp/strict.err"
check_json "$tmp/strict.json" \
  'p.strictTypeOptimizations.enabled === true && p.functions.some(f => f.name === "slen$string") && p.functions.some(f => f.name === "findB$string") && !p.functions.some(f => f.name === "passthrough$string")' \
  "--strict clean program must specialize only useful string generic bodies"
check_json "$tmp/strict.json" \
  'p.functions.some(f => f.name === "slen$string" && f.body.some(i => i.kind === "StringLen")) && p.functions.some(f => f.name === "findB$string" && f.body.some(i => i.kind === "CallBuiltin" && i.builtin === "string.indexOf"))' \
  "string generic specializations must lower to static string IR"

"$TSAOT" "$tmp/strict.json" emit > "$tmp/strict.c" 2>"$tmp/emit.err"
$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>"$tmp/rt.err"
$CC "$tmp/strict.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/strict.bin" 2>"$tmp/cc.err"
got="$("$tmp/strict.bin")"
if [[ "$got" != $'3\n1\nx' ]]; then
  echo "[strict-type-spec] FAIL: strict string specialization output mismatch: $got"
  exit 1
fi

echo "[strict-type-spec] PASS: strict TypeSpec string specialization"
