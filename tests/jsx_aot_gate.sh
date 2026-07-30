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

node "$EXPORTER" "$ROOT/tests/bundler/react_subset/entry.ts" \
  "$tmp/react.json" "$tmp/react.labels.json" >"$tmp/out" 2>"$tmp/err"

node - "$tmp/react.json" "$tmp/react.labels.json" <<'JS'
const fs = require("fs");
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const labels = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const create = root.functions.find((f) => f.name === "createElement");
const createField = root.fields.find((f) => f.name === "createElement");
if (!create) {
  console.error("[jsx-aot] createElement function was not bundled");
  process.exit(1);
}
let directFactoryCalls = 0;
let indirectFactoryLoads = 0;
let concatPlans = 0;
function walk(v) {
  if (!v || typeof v !== "object") return;
  if (v.kind === "Call" && v.callee && v.callee.kind === "Direct" &&
      v.callee.func === create.id) directFactoryCalls++;
  if (createField && v.kind === "LoadField" && v.field === createField.id) indirectFactoryLoads++;
  if (v.kind === "CallBuiltinStatic" && v.builtin === "string.concatMany") concatPlans++;
  for (const x of Object.values(v)) Array.isArray(x) ? x.forEach(walk) : walk(x);
}
walk(root);
const propSites = Object.values(labels).filter((x) =>
  typeof x === "string" && (x.startsWith("jsx-props@") || x.startsWith("jsx-fragment-props@"))).length;
if (directFactoryCalls < 10 || indirectFactoryLoads !== 0 || propSites < 10 || concatPlans < 3) {
  console.error(`[jsx-aot] unexpected plan: direct=${directFactoryCalls} indirect=${indirectFactoryLoads} props=${propSites} concat=${concatPlans}`);
  process.exit(1);
}
JS

echo "[jsx-aot] PASS: raw TSX uses direct factory calls, static prop shapes, and concat plans"
