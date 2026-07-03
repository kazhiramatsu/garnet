#!/usr/bin/env bash
# run_engine_benchmarks.sh — JS エンジン比較ハーネス（refactor plan P0）。
#
#   scripts/run_engine_benchmarks.sh <node|bun|deno> [name-filter-regex]
#
# manifest の各行のうち kernel プロトコル（<source>.js が
# `module.exports = { kernel, BENCH_N }` を持つ）の行を対象に、指定エンジンの
# 1 プロセス内で warm-up + best-of-N を計測する（run_v8_benchmarks.sh の
# エンジン一般化）。結果は表示に加えて JSON を build/bench_history/ に蓄積:
#   build/bench_history/<UTCstamp>_<engine>.json
#
# manifest 前方互換: 7 列目以降（suite / engines）が将来追加されても、この
# ハーネスは 7 列目を suite ラベルとして JSON に含める（無ければ "default"）。
#
# Env: TSAOT_RUNS=N (default 5), TSAOT_MANIFEST=path
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENGINE="${1:?usage: run_engine_benchmarks.sh <node|bun|deno> [filter]}"
FILTER="${2:-}"
RUNS="${TSAOT_RUNS:-5}"
MANIFEST="${TSAOT_MANIFEST:-$ROOT/benchmarks/manifest.tsv}"
case "$ENGINE" in node|bun|deno) ;; *) echo "unknown engine '$ENGINE' (node|bun|deno)"; exit 1 ;; esac
command -v "$ENGINE" >/dev/null 2>&1 || { echo "[engine] $ENGINE not found on PATH"; exit 1; }

HIST="$ROOT/build/bench_history"; mkdir -p "$HIST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HIST/${STAMP}_${ENGINE}.json"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

# --- in-process warmed best-of-N runner（CJS: node/bun 用）---
cat > "$work/runner.cjs" <<'JS'
const modPath = process.argv[2], expected = process.argv[3];
const runs = Number(process.argv[4] || "5");
let bench;
try { bench = require(modPath); } catch (e) { console.log("##R##\t-\t-\tLOAD_ERR"); process.exit(0); }
if (typeof bench.kernel !== "function" || typeof bench.BENCH_N !== "number") {
  console.log("##R##\t-\t-\tNO_KERNEL"); process.exit(0);
}
const out = String(bench.kernel(bench.BENCH_N));           // warm-up + correctness
if (out !== expected) { console.log("##R##\t" + out + "\t-\tWRONG_OUTPUT"); process.exit(0); }
let best = Infinity;
for (let r = 0; r < runs; r++) {
  const t0 = performance.now();
  const got = String(bench.kernel(bench.BENCH_N));
  const dt = performance.now() - t0;
  if (got !== expected) { console.log("##R##\t" + got + "\t-\tWRONG_OUTPUT"); process.exit(0); }
  if (dt < best) best = dt;
}
console.log("##R##\t" + out + "\t" + best.toFixed(1) + "\tPASS");
JS
# --- deno は ESM + createRequire で同じ CJS ref を読む ---
cat > "$work/runner_deno.mjs" <<'JS'
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const [modPath, expected, runsStr] = Deno.args;
const runs = Number(runsStr || "5");
let bench;
try { bench = require(modPath); } catch (e) { console.log("##R##\t-\t-\tLOAD_ERR"); Deno.exit(0); }
if (typeof bench.kernel !== "function" || typeof bench.BENCH_N !== "number") {
  console.log("##R##\t-\t-\tNO_KERNEL"); Deno.exit(0);
}
const out = String(bench.kernel(bench.BENCH_N));
if (out !== expected) { console.log("##R##\t" + out + "\t-\tWRONG_OUTPUT"); Deno.exit(0); }
let best = Infinity;
for (let r = 0; r < runs; r++) {
  const t0 = performance.now();
  const got = String(bench.kernel(bench.BENCH_N));
  const dt = performance.now() - t0;
  if (got !== expected) { console.log("##R##\t" + got + "\t-\tWRONG_OUTPUT"); Deno.exit(0); }
  if (dt < best) best = dt;
}
console.log("##R##\t" + out + "\t" + best.toFixed(1) + "\tPASS");
JS

run_kernel() { # $1=js path  $2=expected  → "out<TAB>ms<TAB>status"
  case "$ENGINE" in
    node) node "$work/runner.cjs" "$1" "$2" "$RUNS" ;;
    bun)  bun  "$work/runner.cjs" "$1" "$2" "$RUNS" ;;
    deno) deno run --quiet --allow-read "$work/runner_deno.mjs" "$1" "$2" "$RUNS" ;;
  esac
}

ver="$($ENGINE --version 2>/dev/null | head -1 | tr -d '"')"
printf "%-30s %-14s %-11s %s\n" "BENCHMARK" "RESULT" "${ENGINE}_MS" "STATUS"
printf -- "----------------------------------------------------------------------\n"

nrows=0; npass=0; nskip=0; nfail=0
rows=""
while IFS=$'\t' read -r name source expected budget v8ref verdict suite _rest; do
  [[ "$name" =~ ^#.*$ || -z "$name" ]] && continue
  [[ -n "$FILTER" ]] && ! [[ "$name" =~ ${FILTER} ]] && continue
  suite="${suite:-default}"
  js="$ROOT/benchmarks/${source%.ts}.js"
  if [[ ! -f "$js" ]]; then
    printf "%-30s %-14s %-11s %s\n" "$name" "-" "-" "NO_JS_REF"; nskip=$((nskip+1)); continue
  fi
  result="$(run_kernel "$js" "$expected" | grep '^##R##' | tail -1 | cut -f2-)"
  [ -n "$result" ] || result="$(printf -- '-\t-\tNO_PROTOCOL')"
  IFS=$'\t' read -r out ms status <<EOF
$result
EOF
  case "$status" in
    PASS) npass=$((npass+1)) ;;
    NO_KERNEL|LOAD_ERR|NO_PROTOCOL) nskip=$((nskip+1)) ;;
    *) nfail=$((nfail+1)) ;;
  esac
  printf "%-30s %-14s %-11s %s\n" "$name" "$out" "$ms" "$status"
  [[ -n "$rows" ]] && rows="$rows,"
  rows="$rows
    {\"name\":\"$name\",\"suite\":\"$suite\",\"ms\":\"$ms\",\"status\":\"$status\"}"
  nrows=$((nrows+1))
done < "$MANIFEST"

printf -- "----------------------------------------------------------------------\n"
echo "[engine:$ENGINE $ver] rows=$nrows pass=$npass skip=$nskip fail=$nfail runs=$RUNS"

cat > "$OUT" <<EOF
{
  "engine": "$ENGINE",
  "version": "$ver",
  "date": "$STAMP",
  "host": "$(uname -sm)",
  "runs": $RUNS,
  "results": [$rows
  ]
}
EOF
echo "[engine] wrote $OUT"
[[ $nfail -eq 0 ]]
