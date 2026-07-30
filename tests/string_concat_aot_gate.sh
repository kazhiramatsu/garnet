#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

TSAOT="$ROOT/analyzer/target/release/tsaot"
EXPORTER="$ROOT/exporter/exporter.js"
[[ -x "$TSAOT" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet)
[[ -f "$EXPORTER" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
  --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)

emit_ir() {
  local name="$1"
  (cd exporter && node exporter.js "$tmp/$name.ts" "$tmp/$name.json" "$tmp/$name.locals.json") \
    >"$tmp/$name.out" 2>"$tmp/$name.err"
}

cat >"$tmp/dynamic.ts" <<'TS'
function render(tag: string, n: number): string {
  return `<${tag}>${n}</${tag}>`;
}
console.log(render("li", 7));
TS
emit_ir dynamic

node - "$tmp/dynamic.json" <<'JS'
const fs = require("fs");
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const calls = [];
function walk(v) {
  if (!v || typeof v !== "object") return;
  if (v.kind === "CallBuiltinStatic" && v.builtin === "string.concatMany") calls.push(v);
  for (const x of Object.values(v)) Array.isArray(x) ? x.forEach(walk) : walk(x);
}
walk(root);
if (calls.length !== 1 || calls[0].args.length !== 7) {
  console.error(`[string-aot] expected one seven-part concatMany, got ${calls.length}`);
  process.exit(1);
}
JS

cat >"$tmp/static.ts" <<'TS'
console.log(`${"a"}${1 + 2}${true}${null}${undefined}${-0}`);
TS
emit_ir static

node - "$tmp/static.json" <<'JS'
const fs = require("fs");
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let concatCalls = 0;
let folded = false;
function walk(v) {
  if (!v || typeof v !== "object") return;
  if (v.kind === "CallBuiltinStatic" && v.builtin === "string.concatMany") concatCalls++;
  if (v.kind === "Const" && v.value && v.value.kind === "Str" &&
      v.value.value === "a3truenullundefined0") folded = true;
  for (const x of Object.values(v)) Array.isArray(x) ? x.forEach(walk) : walk(x);
}
walk(root);
if (concatCalls !== 0 || !folded) {
  console.error(`[string-aot] constant template was not fully folded (concat=${concatCalls}, literal=${folded})`);
  process.exit(1);
}
JS

echo "[string-aot] PASS: templates use one concat plan and fold constant chunks"
