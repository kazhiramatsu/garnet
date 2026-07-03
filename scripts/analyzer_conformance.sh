#!/bin/bash
# Phase 1 driver for the self-hosting TypeScript analyzer (analyzer_ts/).
#
# Runs every conformance fixture through: exporter -> IR -> TS analyzer emit ->
# compile -> run, and compares stdout to the node ESM oracle. Tallies results:
#   PASS         : TS-analyzer binary output == node oracle
#   UNPORTED     : TS analyzer hit a not-yet-ported instruction (work-list)
#   CCFAIL       : emitted C did not compile (a porting bug to fix)
#   DIFF         : compiled+ran but output differs from node (a porting bug)
#   EXPORTER     : exporter rejected the fixture (out of analyzer scope)
#
# The UNPORTED histogram is the prioritized to-do list for the next increment.
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-cc -O2}"
TSAN="node $ROOT/analyzer_ts/dist/main.js"
EXPORTER="$ROOT/exporter/exporter.js"
FILTER="${1:-}"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export ROOT CC
. "$ROOT/scripts/lib/mimalloc_flags.sh" 2>/dev/null || true
. "$ROOT/scripts/lib/regexp_link_flags.sh" || { echo "regexp link flags missing"; exit 1; }
$CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$tmp/rt.o" 2>/dev/null || { echo "runtime build failed"; exit 1; }

# Link an emitted .c into a binary, pulling in the optional regexp/unicode/fetch
# runtime objects the same way the garnet driver does (gated by markers in the C).
cc_link() { # $1=src.c $2=out  ; sets cc.err on failure
  tsaot_prepare_regexp_objs "$1" "$tmp" >/dev/null 2>&1
  tsaot_prepare_unicode_objs "$1" "$tmp" >/dev/null 2>&1
  tsaot_prepare_fetch_runtime "$1" "$tmp" "$tmp/rt.o" >/dev/null 2>&1
  # shellcheck disable=SC2086
  $CC "$1" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS \
    -I"$ROOT/runtime" -lm $TSAOT_FETCH_LDLIBS ${TSAOT_LDLIBS:-} -o "$2" 2>"$tmp/cc.err"
}

# 凍結双子との既知差分（Rust 側で修正済みの silent miscompile を凍結側はまだ持つ
# fixture。scripts/frozen_known_diffs.tsv の scope=selfconf 行）。KNOWN として
# 別集計し PASS 判定から除外する。
KNOWN_NAMES=$(awk -F'\t' '$1=="selfconf"{print $2}' "$ROOT/scripts/frozen_known_diffs.tsv" 2>/dev/null)

pass=0; unported=0; ccfail=0; diff=0; known=0; expfail=0; total=0
: > "$tmp/unported.txt"; : > "$tmp/ccfail.txt"; : > "$tmp/diff.txt"; : > "$tmp/known.txt"

while IFS= read -r ts; do
  case "$ts" in *"$FILTER"*) ;; *) continue ;; esac
  total=$((total+1))
  name="${ts#tests/conformance/exhaustive/}"
  if ! TSAOT_UNTYPED=1 node "$EXPORTER" "$ts" "$tmp/ir.json" "$tmp/l.json" >/dev/null 2>&1; then
    expfail=$((expfail+1)); continue; fi
  if ! $TSAN "$tmp/ir.json" emit > "$tmp/ts.c" 2>"$tmp/ts.err"; then
    if grep -q "^UNPORTED:" "$tmp/ts.err"; then
      unported=$((unported+1)); grep "^UNPORTED:" "$tmp/ts.err" | sed 's/^UNPORTED: //' >> "$tmp/unported.txt"
    else
      ccfail=$((ccfail+1)); echo "$name: $(head -1 "$tmp/ts.err")" >> "$tmp/ccfail.txt"
    fi
    continue
  fi
  if ! cc_link "$tmp/ts.c" "$tmp/ts.bin"; then
    ccfail=$((ccfail+1)); echo "$name: $(grep -m1 error "$tmp/cc.err")" >> "$tmp/ccfail.txt"; continue; fi
  if ! NODE_PATH="$ROOT/exporter/node_modules" node "$ROOT/scripts/_oracle_transpile.js" "$ts" "$tmp/oracle.mjs" 2>/dev/null; then
    expfail=$((expfail+1)); continue; fi
  oracle=$(node "$tmp/oracle.mjs" 2>&1)
  # alarm ガード: 凍結側の既知 miscompile はハング形になり得る（wild tsv の文字列
  # 連結等）。ゲートを止めないよう有限化する（正常 fixture は <2s で終わる）。
  got=$(perl -e 'alarm 20; exec @ARGV' "$tmp/ts.bin" 2>&1)
  if [ "$got" = "$oracle" ]; then pass=$((pass+1)); else
    if printf '%s\n' "$KNOWN_NAMES" | grep -qx "${name%.ts}"; then
      known=$((known+1)); echo "$name" >> "$tmp/known.txt"
    else
      diff=$((diff+1)); echo "$name" >> "$tmp/diff.txt"
    fi
  fi
done < <(find tests/conformance/exhaustive -name "*.ts" | sort)

echo "==================== analyzer_ts conformance ===================="
echo "total=$total  PASS=$pass  UNPORTED=$unported  CCFAIL=$ccfail  DIFF=$diff  KNOWN=$known  EXPORTER-skip=$expfail"
echo
echo "--- top UNPORTED reasons (Phase 1 work-list) ---"
sort "$tmp/unported.txt" | uniq -c | sort -rn | head -30
if [ -s "$tmp/ccfail.txt" ]; then echo; echo "--- CCFAIL (porting bugs, first 15) ---"; head -15 "$tmp/ccfail.txt"; fi
if [ -s "$tmp/diff.txt" ]; then echo; echo "--- DIFF (output mismatch, first 15) ---"; head -15 "$tmp/diff.txt"; fi
if [ -s "$tmp/known.txt" ]; then echo; echo "--- KNOWN frozen diffs (allowlist: scripts/frozen_known_diffs.tsv) ---"; cat "$tmp/known.txt"; fi
