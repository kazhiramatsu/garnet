#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh"

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
    echo "[strict-explicit-spec] FAIL: $label"
    exit 1
  fi
}

cat > "$tmp/explicit.ts" <<'TS'
function id<T>(x: T): T { return x; }
class Box<T> {
  value: T;
  constructor(v: T) { this.value = v; }
  get(): T { return this.value; }
}
function main(): void {
  const a = id<number>(41);
  const b = new Box<number>(1);
  console.log(a + 1, b.get() + 1);
}
main();
TS

node exporter/exporter.js "$tmp/explicit.ts" "$tmp/default.json" "$tmp/default.labels.json" >/dev/null 2>"$tmp/default.err"
check_json "$tmp/default.json" \
  'p.strictTypeOptimizations.enabled === false && !p.functions.some(f => f.name === "id$number") && !p.classes.some(c => String(c.name).includes("Box$number")) && !p.classes.some(c => Object.values(c.fieldTypes || {}).includes("number"))' \
  "default exporter must not specialize explicit numeric generics"

node exporter/exporter.js --strict "$tmp/explicit.ts" "$tmp/strict.json" "$tmp/strict.labels.json" >/dev/null 2>"$tmp/strict.err"
check_json "$tmp/strict.json" \
  'p.strictTypeOptimizations.enabled === true && p.functions.some(f => f.name === "id$number") && p.classes.some(c => String(c.name).includes("Box$number")) && p.classes.some(c => Object.values(c.fieldTypes || {}).includes("number"))' \
  "--strict clean program must keep explicit numeric specialization"

"$TSAOT" "$tmp/strict.json" emit > "$tmp/strict.c" 2>"$tmp/emit.err"
$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>"$tmp/rt.err"
$CC "$tmp/strict.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/strict.bin" 2>"$tmp/cc.err"
got="$("$tmp/strict.bin")"
if [[ "$got" != "42 2" ]]; then
  echo "[strict-explicit-spec] FAIL: strict explicit specialization output mismatch: $got"
  exit 1
fi

cat > "$tmp/unsafe.ts" <<'TS'
function id<T>(x: T): T { return x; }
class Box<T> {
  value: T;
  constructor(v: T) { this.value = v; }
  get(): T { return this.value; }
}
function main(): void {
  const a = id<number>(41 as any);
  const b = new Box<number>(1 as any);
  console.log(a + 1, b.get() + 1);
}
main();
TS

node exporter/exporter.js --strict "$tmp/unsafe.ts" "$tmp/unsafe.json" "$tmp/unsafe.labels.json" >/dev/null 2>"$tmp/unsafe.err"
check_json "$tmp/unsafe.json" \
  'p.strictTypeOptimizations.enabled === true && !p.functions.some(f => f.name === "id$number") && !p.classes.some(c => String(c.name).includes("Box$number")) && !p.classes.some(c => Object.values(c.fieldTypes || {}).includes("number"))' \
  "--strict explicit generics with assertion-tainted arguments must stay erased"

echo "[strict-explicit-spec] PASS: explicit numeric specialization is strict-only"
