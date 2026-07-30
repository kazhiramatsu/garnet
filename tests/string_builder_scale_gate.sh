#!/usr/bin/env bash
# Non-ASan and ASan scale coverage for the hidden-buffer/prefix-view string
# builder. This intentionally stays outside ordinary conformance: its final
# string is 64 MiB and exists to catch size-dependent ownership/GC failures.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SRC="$ROOT/tests/scale/string_builder_64mb.ts"
EXPORTER="$ROOT/exporter/exporter.js"
TSAOT="$ROOT/analyzer/target/release/tsaot"
CC="${TSAOT_CC:-cc}"
ASAN_CC="${TSAOT_STRING_SCALE_ASAN_CC:-cc}"
RUN_ASAN="${TSAOT_STRING_SCALE_ASAN:-1}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

[[ -x "$TSAOT" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet)
[[ -f "$EXPORTER" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc \
  exporter.ts class_extract.ts --module commonjs --target es2020 \
  --skipLibCheck --moduleResolution node --esModuleInterop)

node "$EXPORTER" "$SRC" "$tmp/program.json" "$tmp/labels.json" >/dev/null
"$TSAOT" "$tmp/program.json" emit > "$tmp/program.c"

node - "$SRC" "$tmp/reference.js" <<'JS'
const fs = require("fs");
const ts = require(process.cwd() + "/exporter/node_modules/typescript");
const src = fs.readFileSync(process.argv[2], "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
fs.writeFileSync(process.argv[3], js);
JS
expected="$(node "$tmp/reference.js")"

$CC -O2 "$tmp/program.c" runtime/ts_rt.c -Iruntime -lm -o "$tmp/program"
actual="$(TSAOT_GC_YOUNG_THRESHOLD=1 "$tmp/program")"
if [[ "$actual" != "$expected" ]]; then
  echo "[string-builder-scale] O2 mismatch"
  echo "expected: $expected"
  echo "actual:   $actual"
  exit 1
fi

if [[ "$RUN_ASAN" != "0" ]]; then
  $ASAN_CC -O0 -g -fsanitize=address "$tmp/program.c" runtime/ts_rt.c \
    -Iruntime -lm -o "$tmp/program_asan"
  actual="$(ASAN_OPTIONS=detect_leaks=0 TSAOT_GC_YOUNG_THRESHOLD=1 "$tmp/program_asan")"
  if [[ "$actual" != "$expected" ]]; then
    echo "[string-builder-scale] ASan mismatch"
    echo "expected: $expected"
    echo "actual:   $actual"
    exit 1
  fi
fi

echo "[string-builder-scale] PASS: 64 MiB prefix/branch/slice build matches V8 under O2 and ASan"
