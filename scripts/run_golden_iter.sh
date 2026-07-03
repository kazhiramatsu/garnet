#!/usr/bin/env bash
# Golden tests for the iteration machinery (for-of / for-await / yield* / generators
# / custom iterators / finally interactions). Each case is compiled with tsaot AND
# run under V8; both must agree. Acts as a regression net around iteration changes.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DIR="tests/golden/iter"
RT="runtime/ts_rt.c"; INC="runtime"
EX="exporter/exporter.js"
TSAOT="analyzer/target/release/tsaot"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
. "$ROOT/scripts/lib/regexp_link_flags.sh" || exit 1
tmp=$(mktemp -d)
fail=0; n=0
# Precompile the runtime ONCE; link each golden against it (the runtime is
# identical across goldens — recompiling ts_rt.c per test dominated wall time).
RT_OBJ="$tmp/ts_rt.o"
if ! $CC -c "$RT" -I"$INC" -o "$RT_OBJ" 2>"$tmp/rt.gcc"; then
  echo "[golden] FATAL: runtime failed to compile"; cat "$tmp/rt.gcc"; exit 1
fi
for ts in "$DIR"/*.ts; do
  name=$(basename "$ts" .ts)
  printf '%s\t%s\n' "$name" "$ROOT/$ts" >> "$tmp/batch.tsv"
done
# Batch-export ALL goldens in one node process (shared lib cache) instead of one
# node invocation per file (~1.8s each). Massive speedup on the export stage.
node "$EX" --batch "$tmp/batch.tsv" "$tmp/json" >"$tmp/batch.status" 2>"$tmp/batch.err" || true
for ts in "$DIR"/*.ts; do
  name=$(basename "$ts" .ts); n=$((n+1))
  jsref="$DIR/$name.js"
  if [[ ! -f "$jsref" ]]; then echo "[golden] MISSING js ref: $name"; fail=1; continue; fi
  v8=$(node "$jsref" 2>&1 | tr '\n' '|')
  # AOT (from the batch export)
  if [[ ! -f "$tmp/json/$name.program.json" ]]; then
    echo "[golden] EXPORT_FAIL: $name"; grep "\[$name\]" "$tmp/batch.err" | head -2; fail=1; continue
  fi
  "$TSAOT" "$tmp/json/$name.program.json" emit > "$tmp/$name.c" 2>/dev/null
  if ! tsaot_prepare_regexp_objs "$tmp/$name.c" "$tmp" 2>"$tmp/$name.rx"; then
    echo "[golden] REGEXP_LINK_PREP_FAIL: $name"; fail=1; continue
  fi
  if ! tsaot_prepare_unicode_objs "$tmp/$name.c" "$tmp" 2>"$tmp/$name.uc"; then
    echo "[golden] UNICODE_LINK_PREP_FAIL: $name"; fail=1; continue
  fi
  if ! tsaot_prepare_fetch_runtime "$tmp/$name.c" "$tmp" "$RT_OBJ" 2>"$tmp/$name.fetch"; then
    echo "[golden] FETCH_LINK_PREP_FAIL: $name"; fail=1; continue
  fi
  if ! $CC "$tmp/$name.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$INC" -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS -o "$tmp/$name" 2>"$tmp/$name.gcc"; then
    echo "[golden] GCC_FAIL: $name"; fail=1; continue
  fi
  aot=$("$tmp/$name" 2>&1 | tr '\n' '|')
  if [[ "$aot" == "$v8" ]]; then
    echo "[golden] PASS: $name  ($aot)"
  else
    echo "[golden] FAIL: $name  AOT=[$aot] V8=[$v8]"; fail=1
  fi
done
rm -rf "$tmp"
echo "[golden] $n cases"
[[ $fail -eq 0 ]] && echo "[golden] ALL PASS" || echo "[golden] FAILURES"
exit $fail
