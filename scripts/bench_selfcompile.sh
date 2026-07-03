#!/usr/bin/env bash
# bench_selfcompile.sh — self-compile のステージ分割計測（refactor plan P0）。
# 旗艦 real benchmark: garnet が凍結 analyzer_ts（66k 命令の実プログラム）を
# 処理する速度を、実装別・ステージ別に計測して build/bench_history/ に蓄積する。
#
#   scripts/bench_selfcompile.sh [--native <tsan-binary>] [--runs N] [--no-cc]
#
# ステージ:
#   export       node exporter（typed）: selfhost_typed.ts → self.ir.json
#   emit-rust    Rust analyzer:  tsaot self.ir emit → C
#   emit-node    凍結TS on node: main.js self.ir emitc → C
#   emit-native  garnet 製 native tsan（--native / TSAOT_TSAN_NATIVE 指定時のみ。
#                ~数百秒かかる。ulimit -s 65520 で実行）
#   cc           生成 C の cc -O2 + link（emit-rust の出力を使用）
# おまけ: emit-rust と emit-node の byte 一致（parity）も検査して報告する。
#
# 解析パス内部の分割（devirt/escape/sroa/fixpoint 別）は analyzer 側の計装が
# 必要なため P2 で追加予定（このスクリプトの出力形式はその受け皿を持つ）。
#
# Env: TSAOT_RUNS=N (default 3)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUNS="${TSAOT_RUNS:-3}"
NATIVE="${TSAOT_TSAN_NATIVE:-}"
DO_CC=1
while [ $# -gt 0 ]; do
  case "$1" in
    --native) shift; NATIVE="${1:?--native needs a path}" ;;
    --runs)   shift; RUNS="${1:?--runs needs N}" ;;
    --no-cc)  DO_CC=0 ;;
    *) echo "usage: bench_selfcompile.sh [--native <tsan-binary>] [--runs N] [--no-cc]"; exit 1 ;;
  esac
  shift
done

RUST="$ROOT/analyzer/target/release/tsaot"
[ -x "$RUST" ] || { echo "[selfcompile] Rust analyzer not built ($RUST)"; exit 1; }
[ -f "$ROOT/analyzer_ts/dist/main.js" ] || { echo "[selfcompile] analyzer_ts/dist not built (cd analyzer_ts && tsc -p tsconfig.json)"; exit 1; }
[ -f "$ROOT/exporter/exporter.js" ] || { echo "[selfcompile] exporter not built"; exit 1; }

W="${TMPDIR:-/tmp}/selfcompile_bench"; mkdir -p "$W"
HIST="$ROOT/build/bench_history"; mkdir -p "$HIST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null \
        || perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'; }

best_of() { # $1=label, rest=command…  → best ms を echo（stdout はコマンド側で処理済み前提）
  local label="$1"; shift
  local best=99999999 r t0 t1 dt
  for ((r=0; r<RUNS; r++)); do
    t0=$(now_ms); "$@" || { echo "[selfcompile] FAIL: $label" >&2; return 1; }
    t1=$(now_ms); dt=$((t1-t0)); [ "$dt" -lt "$best" ] && best=$dt
  done
  echo "$best"
}

echo "[selfcompile] runs=$RUNS (best-of)"

# ---- export (typed) ----
export_run() { node exporter/exporter.js analyzer_ts/src/selfhost_typed.ts "$W/self.ir.json" "$W/self.l.json" >/dev/null 2>&1; }
t_export=$(best_of export export_run) || exit 1
ir_bytes=$(wc -c < "$W/self.ir.json" | tr -d ' ')

# ---- emit: Rust ----
rust_run() { "$RUST" "$W/self.ir.json" emit > "$W/rust.c" 2>/dev/null; }
t_rust=$(best_of emit-rust rust_run) || exit 1
c_bytes=$(wc -c < "$W/rust.c" | tr -d ' ')

# ---- emit: 凍結 TS on node ----
node_run() { node analyzer_ts/dist/main.js "$W/self.ir.json" emitc > "$W/node.c" 2>/dev/null; }
t_node=$(best_of emit-node node_run) || exit 1

# ---- parity（無料の回帰チェック）----
if cmp -s "$W/rust.c" "$W/node.c"; then parity="identical"; else parity="**MISMATCH**"; fi

# ---- emit: native（任意・重い）----
t_native="-"
if [ -n "$NATIVE" ]; then
  [ -x "$NATIVE" ] || { echo "[selfcompile] native binary not executable: $NATIVE"; exit 1; }
  native_run() { (ulimit -s 65520; "$NATIVE" < "$W/self.ir.json" > "$W/native.c" 2>/dev/null); }
  t0=$(now_ms); native_run || { echo "[selfcompile] FAIL: emit-native"; exit 1; }
  t1=$(now_ms); t_native=$((t1-t0))   # 1 回のみ（数百秒級のため）
  cmp -s "$W/rust.c" "$W/native.c" && parity="$parity, native=identical" || parity="$parity, native=**MISMATCH**"
fi

# ---- cc ----
t_cc="-"
if [ "$DO_CC" -eq 1 ]; then
  export CC="${TSAOT_CC:-cc -O2}"
  . "$ROOT/scripts/lib/mimalloc_flags.sh" 2>/dev/null || true
  . "$ROOT/scripts/lib/regexp_link_flags.sh" || exit 1
  RT_OBJ="$W/rt.o"
  [ -f "$RT_OBJ" ] && [ ! "$ROOT/runtime/ts_rt.c" -nt "$RT_OBJ" ] || $CC -c runtime/ts_rt.c -Iruntime -o "$RT_OBJ" || exit 1
  tsaot_prepare_regexp_objs "$W/rust.c" "$W" >/dev/null 2>&1
  tsaot_prepare_unicode_objs "$W/rust.c" "$W" >/dev/null 2>&1
  tsaot_prepare_fetch_runtime "$W/rust.c" "$W" "$RT_OBJ" >/dev/null 2>&1
  cc_run() { # shellcheck disable=SC2086
    $CC "$W/rust.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS \
      -Iruntime -lm $TSAOT_FETCH_LDLIBS ${TSAOT_LDLIBS:-} -o "$W/tsan_bin" 2>"$W/cc.err"; }
  t_cc=$(best_of cc cc_run) || { head -3 "$W/cc.err"; exit 1; }
fi

echo
printf "%-14s %10s\n" "STAGE" "BEST_MS"
printf -- "---------------------------\n"
printf "%-14s %10s\n" "export"      "$t_export"
printf "%-14s %10s\n" "emit-rust"   "$t_rust"
printf "%-14s %10s\n" "emit-node"   "$t_node"
printf "%-14s %10s\n" "emit-native" "$t_native"
printf "%-14s %10s\n" "cc"          "$t_cc"
printf -- "---------------------------\n"
echo "[selfcompile] IR=${ir_bytes}B C=${c_bytes}B parity=$parity"

OUT="$HIST/${STAMP}_selfcompile.json"
cat > "$OUT" <<EOF
{
  "date": "$STAMP",
  "host": "$(uname -sm)",
  "runs": $RUNS,
  "ir_bytes": $ir_bytes,
  "c_bytes": $c_bytes,
  "parity": "$parity",
  "stages_ms": {
    "export": $t_export,
    "emit_rust": $t_rust,
    "emit_node": $t_node,
    "emit_native": $([ "$t_native" = "-" ] && echo null || echo "$t_native"),
    "cc": $([ "$t_cc" = "-" ] && echo null || echo "$t_cc")
  },
  "pass_stages_ms": null
}
EOF
echo "[selfcompile] wrote $OUT"
case "$parity" in *MISMATCH*) exit 1 ;; esac
