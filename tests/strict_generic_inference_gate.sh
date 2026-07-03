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
    echo "[strict-generic-infer] FAIL: $label"
    exit 1
  fi
}

cat > "$tmp/infer.ts" <<'TS'
function id<T>(x: T): T { return x; }
function main(): void { console.log(id(41) + 1); }
main();
TS

node exporter/exporter.js "$tmp/infer.ts" "$tmp/default.json" "$tmp/default.labels.json" >/dev/null 2>"$tmp/default.err"
check_json "$tmp/default.json" \
  'p.strictTypeOptimizations.enabled === false && !p.functions.some(f => f.name === "id$number")' \
  "default exporter must not infer generic monomorphization"

node exporter/exporter.js --strict "$tmp/infer.ts" "$tmp/strict.json" "$tmp/strict.labels.json" >/dev/null 2>"$tmp/strict.err"
check_json "$tmp/strict.json" \
  'p.strictTypeOptimizations.enabled === true && p.functions.some(f => f.name === "id$number")' \
  "--strict clean program must infer numeric generic monomorphization"

"$TSAOT" "$tmp/strict.json" emit > "$tmp/strict.c" 2>"$tmp/emit.err"
$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>"$tmp/rt.err"
$CC "$tmp/strict.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/strict.bin" 2>"$tmp/cc.err"
got="$("$tmp/strict.bin")"
if [[ "$got" != "42" ]]; then
  echo "[strict-generic-infer] FAIL: strict inferred generic output mismatch: $got"
  exit 1
fi

cat > "$tmp/array_infer.ts" <<'TS'
function first<T>(xs: T[]): T { return xs[0]; }
function firstPair<T>(xs: [T, T]): T { return xs[0]; }
function main(): void {
  console.log(first([41]) + 1);
  console.log(firstPair([40, 2]) + 1);
}
main();
TS

node exporter/exporter.js "$tmp/array_infer.ts" "$tmp/array_default.json" "$tmp/array_default.labels.json" >/dev/null 2>"$tmp/array_default.err"
check_json "$tmp/array_default.json" \
  'p.strictTypeOptimizations.enabled === false && !p.functions.some(f => f.name === "first$number" || f.name === "firstPair$number")' \
  "default exporter must not infer array/tuple generic monomorphization"

node exporter/exporter.js --strict "$tmp/array_infer.ts" "$tmp/array_strict.json" "$tmp/array_strict.labels.json" >/dev/null 2>"$tmp/array_strict.err"
check_json "$tmp/array_strict.json" \
  'p.strictTypeOptimizations.enabled === true && p.functions.some(f => f.name === "first$number") && p.functions.some(f => f.name === "firstPair$number")' \
  "--strict clean program must infer array/tuple numeric generic monomorphization"

"$TSAOT" "$tmp/array_strict.json" emit > "$tmp/array_strict.c" 2>"$tmp/array_emit.err"
$CC "$tmp/array_strict.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/array_strict.bin" 2>"$tmp/array_cc.err"
got="$("$tmp/array_strict.bin")"
if [[ "$got" != $'42\n41' ]]; then
  echo "[strict-generic-infer] FAIL: strict inferred array/tuple output mismatch: $got"
  exit 1
fi

cat > "$tmp/explicit_any.ts" <<'TS'
function passthrough<T>(x: T): T {
  const y: any = x;
  return y;
}
function main(): void { console.log(passthrough(41) + 1); }
main();
TS

node exporter/exporter.js --strict "$tmp/explicit_any.ts" "$tmp/explicit_any.json" "$tmp/explicit_any.labels.json" >/dev/null 2>"$tmp/explicit_any.err"
check_json "$tmp/explicit_any.json" \
  'p.strictTypeOptimizations.enabled === true && !p.functions.some(f => f.name === "passthrough$number")' \
  "--strict generic body with explicit any must stay erased"

echo "[strict-generic-infer] PASS: strict-only inferred generic monomorphization"
