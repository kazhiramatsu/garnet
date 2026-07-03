#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/mimalloc_flags.sh"
. "$ROOT/scripts/regexp_link_flags.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

TSAOT="$ROOT/analyzer/target/release/tsaot"
EXPORTER="$ROOT/exporter/exporter.js"
[[ -x "$TSAOT" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet)
[[ -f "$EXPORTER" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)

RT_OBJ="$tmp/ts_rt.o"
$CC -c runtime/ts_rt.c -Iruntime -o "$RT_OBJ" 2>"$tmp/rt.err"
if nm -u "$RT_OBJ" 2>/dev/null | grep -q 'curl_'; then
  echo "[fetch-aot] FAIL: default runtime object still references curl"
  nm -u "$RT_OBJ" | grep 'curl_'
  exit 1
fi

emit_ts() {
  local name="$1"
  (cd exporter && node exporter.js "$tmp/$name.ts" "$tmp/$name.json" "$tmp/$name.l.json") 2>"$tmp/$name.exp.err"
  "$TSAOT" "$tmp/$name.json" emit > "$tmp/$name.c" 2>"$tmp/$name.emit.err"
}

cat > "$tmp/nofetch.ts" <<'TS'
console.log("no fetch");
TS
emit_ts nofetch
if grep -q 'TSAOT_NEEDS_FETCH' "$tmp/nofetch.c"; then
  echo "[fetch-aot] FAIL: no-fetch program emitted fetch marker"
  exit 1
fi
if grep -q 'ts_fnval_global_fetch\|ts_global_set("fetch"\|ts_fetch(' "$tmp/nofetch.c"; then
  echo "[fetch-aot] FAIL: no-fetch program emitted fetch adapter/setup"
  exit 1
fi
tsaot_prepare_fetch_runtime "$tmp/nofetch.c" "$tmp" "$RT_OBJ"
if [[ "$TSAOT_FETCH_RT_OBJ_ARG" != "$RT_OBJ" || -n "$TSAOT_FETCH_LDLIBS" ]]; then
  echo "[fetch-aot] FAIL: no-fetch program switched runtime/link flags"
  exit 1
fi
$CC "$tmp/nofetch.c" "$TSAOT_FETCH_RT_OBJ_ARG" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/nofetch"

cat > "$tmp/fetch.ts" <<'TS'
async function main(): Promise<void> {
  const r = await fetch("https://example.com/");
  console.log(r.status >= 0);
}
TS
emit_ts fetch
grep -q 'TSAOT_NEEDS_FETCH' "$tmp/fetch.c" || {
  echo "[fetch-aot] FAIL: fetch call did not emit fetch marker"
  exit 1
}
grep -q 'ts_global_set("fetch"' "$tmp/fetch.c" || {
  echo "[fetch-aot] FAIL: fetch program did not register global fetch"
  exit 1
}
tsaot_prepare_fetch_runtime "$tmp/fetch.c" "$tmp" "$RT_OBJ"
if [[ "$TSAOT_FETCH_RT_OBJ_ARG" == "$RT_OBJ" || "$TSAOT_FETCH_LDLIBS" != "-lcurl" ]]; then
  echo "[fetch-aot] FAIL: fetch program did not switch to fetch runtime/link flags"
  exit 1
fi
if ! nm -u "$TSAOT_FETCH_RT_OBJ_ARG" 2>/dev/null | grep -q 'curl_'; then
  echo "[fetch-aot] FAIL: fetch runtime object does not reference curl"
  exit 1
fi
$CC "$tmp/fetch.c" "$TSAOT_FETCH_RT_OBJ_ARG" -Iruntime -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS -o "$tmp/fetch.bin"

cat > "$tmp/fetch_value.ts" <<'TS'
const f = globalThis["fetch"];
console.log(typeof f);
TS
emit_ts fetch_value
grep -q 'TSAOT_NEEDS_FETCH' "$tmp/fetch_value.c" || {
  echo "[fetch-aot] FAIL: globalThis fetch value did not emit fetch marker"
  exit 1
}

echo "[fetch-aot] PASS: fetch marker controls libcurl runtime linkage"
