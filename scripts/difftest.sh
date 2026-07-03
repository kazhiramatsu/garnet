#!/usr/bin/env bash
# Set up the V8 differential-test harness in a repo-relative way.
# Usage:  source scripts/difftest.sh   (from the repo root)
# Then:   dt "name" 'function main(){ ... }main();'
#
# Requires (run scripts/setup.sh first if missing):
#   - exporter/node_modules            (npm install in exporter/)
#   - exporter/exporter.js             (tsc build of exporter.ts)
#   - analyzer/target/release/tsaot    (cargo build --release)
#   - build/rt.o                       (gcc -c runtime/ts_rt.c)
#
# Compares tsaot's native output against node (which strips TS types via the
# bundled typescript compiler and evals the result).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export ROOT
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || return 1
. "$ROOT/scripts/lib/regexp_link_flags.sh" || return 1
mkdir -p "$ROOT/build"

# Generate the node reference runner (uses the exporter's bundled typescript).
# Reference runner: transpile to an ES MODULE (.mjs) and run it, so the V8
# oracle observes ESM semantics (always-strict, frozen/non-extensible writes
# throw, top-level await) — matching how tsaot compiles (`module: ESNext`).
cat > "$ROOT/build/noderun.js" <<JS
const ts = require("$ROOT/exporter/node_modules/typescript");
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
fs.writeFileSync(process.argv[2].replace(/\.ts$/, ".mjs"), js);
JS

dt() {
  local name="$1" src="$2"
  echo "$src" > "$ROOT/build/dt.ts"
  local nodeout
  node "$ROOT/build/noderun.js" "$ROOT/build/dt.ts" 2>/dev/null
  nodeout=$(node "$ROOT/build/dt.mjs" 2>&1 | tr '\n' '|')
  local rej
  rej=$(node "$ROOT/exporter/exporter.js" "$ROOT/build/dt.ts" "$ROOT/build/dt.json" "$ROOT/build/dtl.json" 2>&1 | grep -iE "UNSUPPORTED|member" | head -1)
  if [ -n "$rej" ]; then printf "%-38s REJECT (node=%s)\n" "$name" "$nodeout"; return; fi
  "$ROOT/analyzer/target/release/tsaot" "$ROOT/build/dt.json" emit > "$ROOT/build/dt.c" 2>/dev/null
  tsaot_prepare_regexp_objs "$ROOT/build/dt.c" "$ROOT/build" || return
  tsaot_prepare_unicode_objs "$ROOT/build/dt.c" "$ROOT/build" || return
  tsaot_prepare_fetch_runtime "$ROOT/build/dt.c" "$ROOT/build" "$ROOT/build/rt.o" || return
  $CC "$ROOT/build/dt.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$ROOT/runtime" -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS -o "$ROOT/build/dt" 2>&1 | grep -i error
  local aot
  aot=$("$ROOT/build/dt" 2>&1 | tr '\n' '|')
  if [ "$aot" == "$nodeout" ]; then printf "%-38s OK\n" "$name"
  else printf "%-38s DIFF\n   aot =[%s]\n   node=[%s]\n" "$name" "$aot" "$nodeout"; fi
}
