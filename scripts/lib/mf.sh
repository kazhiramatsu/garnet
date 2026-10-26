#!/usr/bin/env bash
# Multi-file (bundler) differential test harness.
#   source scripts/lib/mf.sh
#   mf "name" <dir-with-entry.ts-and-siblings>
# Compiles the entry (tsaot bundles the whole module graph) to a native binary
# and compares its output against a node ESM baseline (each .ts transpiled to
# .mjs with relative specifiers rewritten to .mjs, then `node entry.mjs`).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
export ROOT
CC="${TSAOT_CC:-gcc -O2}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || return 1
. "$ROOT/scripts/lib/regexp_link_flags.sh" || return 1
mkdir -p "$ROOT/build"
RT_OBJ="$ROOT/build/rt.o"
if [ ! -f "$RT_OBJ" ] ||
   [ "$ROOT/runtime/ts_rt.c" -nt "$RT_OBJ" ] ||
   [ "$ROOT/runtime/ts_rt.h" -nt "$RT_OBJ" ] ||
   [ "$ROOT/runtime/ts_ieee754.c" -nt "$RT_OBJ" ]; then
  $CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$RT_OBJ" || return 1
fi

# node ESM baseline runner: transpile every .ts/.tsx in the dir to .mjs (ESNext),
# rewrite `from "./x"` -> `from "./x.mjs"`, run entry.mjs.
cat > "$ROOT/build/mfnode.js" <<'JS'
const ts = require(process.env.ROOT + "/exporter/node_modules/typescript");
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  let js = ts.transpileModule(src, { compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.React,
  } }).outputText;
  js = js.replace(/(from\s*['"])(\.\.?\/[^'"]+?)(['"])/g, (m, a, p, b) => a + (p.endsWith(".mjs") ? p : p + ".mjs") + b);
  js = js.replace(/(import\s*['"])(\.\.?\/[^'"]+?)(['"])/g, (m, a, p, b) => a + (p.endsWith(".mjs") ? p : p + ".mjs") + b);
  fs.writeFileSync(path.join(dir, f.replace(/\.tsx?$/, ".mjs")), js);
}
JS

mf() {
  local name="$1" dir="$2"
  local entry="$dir/entry.ts"
  # node baseline
  node "$ROOT/build/mfnode.js" "$dir" 2>/dev/null
  local nodeout
  # a program importing one of garnet's modules (`garnet:<name>`) runs node with the scheme's loader
  local nodeflags=""
  grep -lq "garnet:" "$dir"/*.mjs 2>/dev/null && nodeflags="--import $ROOT/scripts/garnet_scheme_loader.mjs"
  nodeout=$(node $nodeflags "$dir/entry.mjs" 2>&1 | tr '\n' '|')
  # tsaot bundle
  local exout
  exout=$(node "$ROOT/exporter/exporter.js" "$entry" "$dir/out.json" "$dir/lbl.json" 2>&1)
  local rej
  rej=$(printf "%s" "$exout" | grep -iE "UNSUPPORTED" | head -1)
  if [ -n "$rej" ]; then printf "%-34s REJECT (%s) node=[%s]\n" "$name" "$(printf "%s" "$exout" | grep -E ' - ' | head -1)" "$nodeout"; return; fi
  if [ ! -f "$dir/out.json" ]; then printf "%-34s EXPORTER-ERR\n%s\n" "$name" "$(printf "%s" "$exout" | head -4)"; return; fi
  "$ROOT/analyzer/target/release/tsaot" "$dir/out.json" emit > "$dir/out.c" 2>/dev/null
  tsaot_prepare_regexp_objs "$dir/out.c" "$dir" >/dev/null 2>&1
  tsaot_prepare_unicode_objs "$dir/out.c" "$dir" >/dev/null 2>&1
  tsaot_prepare_fetch_runtime "$dir/out.c" "$dir" "$RT_OBJ" >/dev/null 2>&1
  $CC "$dir/out.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$ROOT/runtime" -lm $TSAOT_FETCH_LDLIBS -o "$dir/prog" 2>&1 | grep -i error
  local aot
  aot=$("$dir/prog" 2>&1 | tr '\n' '|')
  if [ "$aot" = "$nodeout" ]; then printf "%-34s OK\n" "$name"
  else printf "%-34s DIFF\n   aot =[%s]\n   node=[%s]\n" "$name" "$aot" "$nodeout"; fi
}
