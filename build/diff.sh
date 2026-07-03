#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.."
ROOT="$(pwd)"; RT="$ROOT/runtime"; CC=gcc; export CC
. "$ROOT/scripts/lib/regexp_link_flags.sh" 2>/dev/null
. "$ROOT/scripts/lib/mimalloc_flags.sh" 2>/dev/null || true
W=build/dw; mkdir -p "$W"
RT_OBJ="$ROOT/build/rt.o"
diff() {
  local label="$1" src="$2"
  echo "$src" > "$W/d.ts"
  if ! node exporter/exporter.js "$W/d.ts" "$W/d.json" "$W/d.l.json" >/dev/null 2>"$W/d.err"; then echo "[reject] $label"; return; fi
  analyzer/target/release/tsaot "$W/d.json" emit > "$W/d.c" 2>"$W/d.cerr" || { echo "[AOTFAIL-analyzer] $label: $(head -1 $W/d.cerr)"; return; }
  tsaot_prepare_regexp_objs "$W/d.c" "$W" 2>/dev/null
  tsaot_prepare_unicode_objs "$W/d.c" "$W" 2>/dev/null
  tsaot_prepare_fetch_runtime "$W/d.c" "$W" "$RT_OBJ" 2>/dev/null
  if ! eval gcc -O2 "$W/d.c" $TSAOT_FETCH_RT_OBJ_ARG $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$RT" -lm $TSAOT_FETCH_LDLIBS -o "$W/d.bin" 2>"$W/d.gerr"; then echo "[AOTFAIL-gcc] $label: $(head -1 $W/d.gerr)"; return; fi
  local aot v8
  aot="$("$W/d.bin" 2>&1)"
  v8="$(node -e "const ts=require('./exporter/node_modules/typescript');const s=require('fs').readFileSync('$W/d.ts','utf8');try{eval(ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText);}catch(e){console.log('THROW:'+(e&&e.message))}" 2>&1)"
  if [ "$aot" != "$v8" ]; then
    echo "### MISMATCH: $label"
    echo "  AOT: $(echo "$aot" | tr '\n' '|')"
    echo "  V8 : $(echo "$v8" | tr '\n' '|')"
  fi
}
