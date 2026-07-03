#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
. "$ROOT/scripts/lib/regexp_link_flags.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/no_regexp.ts" <<'TS'
function main(): void {
  console.log("abc".indexOf("b"), "abc".replace("b", "X"));
}
main();
TS

if [[ ! -x analyzer/target/release/tsaot ]]; then
  (cd analyzer && cargo build --release --quiet)
fi
if [[ ! -f exporter/exporter.js && -d exporter/node_modules ]]; then
  (cd exporter && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
    --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)
fi

if ! node exporter/exporter.js "$tmp/no_regexp.ts" "$tmp/no_regexp.json" "$tmp/no_regexp.lines.json" \
    >"$tmp/export.out" 2>"$tmp/export.err"; then
  cat "$tmp/export.err"
  exit 1
fi
if ! analyzer/target/release/tsaot "$tmp/no_regexp.json" emit > "$tmp/no_regexp.c" 2>"$tmp/emit.err"; then
  cat "$tmp/emit.err"
  exit 1
fi

if grep -E 'RegExp|libregexp|libunicode|ts_regexp_' "$tmp/no_regexp.c" >/dev/null; then
  echo "[regexp-gate] FAIL: no-RegExp program emitted RegExp support"
  grep -nE 'RegExp|libregexp|libunicode|ts_regexp_' "$tmp/no_regexp.c" | head -20
  exit 1
fi
tsaot_prepare_regexp_objs "$tmp/no_regexp.c" "$tmp"
if (( ${#TSAOT_REGEXP_OBJS[@]} != 0 )); then
  echo "[regexp-gate] FAIL: no-RegExp program requested optional RegExp objects"
  printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}"
  exit 1
fi

echo "[regexp-gate] PASS: no-RegExp program emits no RegExp support"
