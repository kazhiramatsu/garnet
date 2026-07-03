#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
. "$ROOT/scripts/lib/regexp_link_flags.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/no_unicode.ts" <<'TS'
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

if ! node exporter/exporter.js "$tmp/no_unicode.ts" "$tmp/no_unicode.json" "$tmp/no_unicode.lines.json" \
    >"$tmp/export.out" 2>"$tmp/export.err"; then
  cat "$tmp/export.err"
  exit 1
fi
if ! analyzer/target/release/tsaot "$tmp/no_unicode.json" emit > "$tmp/no_unicode.c" 2>"$tmp/emit.err"; then
  cat "$tmp/emit.err"
  exit 1
fi

if grep -E 'TSAOT_NEEDS_UNICODE|ts_unicode_|ts_strproto_normalize|libunicode' "$tmp/no_unicode.c" >/dev/null; then
  echo "[unicode-gate] FAIL: no-Unicode program emitted Unicode support"
  grep -nE 'TSAOT_NEEDS_UNICODE|ts_unicode_|ts_strproto_normalize|libunicode' "$tmp/no_unicode.c" | head -20
  exit 1
fi
tsaot_prepare_unicode_objs "$tmp/no_unicode.c" "$tmp"
if (( ${#TSAOT_UNICODE_OBJS[@]} != 0 )); then
  echo "[unicode-gate] FAIL: no-Unicode program requested optional Unicode objects"
  printf '%s\n' "${TSAOT_UNICODE_OBJS[@]}"
  exit 1
fi

cat > "$tmp/needs_case.ts" <<'TS'
function main(): void {
  const key: any = "toLocaleUpperCase";
  const s: any = "\u0390";
  console.log(s[key]("tr"));
}
main();
TS
node exporter/exporter.js "$tmp/needs_case.ts" "$tmp/needs_case.json" "$tmp/needs_case.lines.json" \
  >"$tmp/case.export.out" 2>"$tmp/case.export.err"
analyzer/target/release/tsaot "$tmp/needs_case.json" emit > "$tmp/needs_case.c" 2>"$tmp/case.emit.err"
if ! grep -q '^#define TSAOT_NEEDS_UNICODE 1' "$tmp/needs_case.c"; then
  echo "[unicode-gate] FAIL: computed-key locale case-mapping program did not request Unicode support"
  sed -n '1,20p' "$tmp/needs_case.c"
  exit 1
fi
tsaot_prepare_unicode_objs "$tmp/needs_case.c" "$tmp"
if (( ${#TSAOT_UNICODE_OBJS[@]} == 0 )); then
  echo "[unicode-gate] FAIL: computed-key case-mapping program did not prepare optional Unicode objects"
  exit 1
fi

echo "[unicode-gate] PASS: Unicode marker is precise for no-Unicode and computed-key case-mapping programs"
