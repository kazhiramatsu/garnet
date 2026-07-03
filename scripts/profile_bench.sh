#!/usr/bin/env bash
# profile_bench.sh — プロファイル取得の定型導線（refactor plan P0）。
#
#   scripts/profile_bench.sh <input.ts | native-binary> [args...]
#
# 入力が .ts なら `garnet --profile` でビルドしてから計測。既存バイナリなら
# そのまま計測（-g -fno-omit-frame-pointer 付きでビルドされていること）。
#
#   macOS : sample(1) でプロセスをサンプリング → build/profiles/<name>.sample.txt
#           （短命プロセスは attach 前に終わることがある。対象は数秒以上
#             走るベンチにすること。TSAOT_PROFILE_SECS で上限秒数を変更）
#   Linux : perf record -g → build/profiles/<name>.perf.data + 上位を表示
#
# ランタイム統計（GC 回数・プローブ長など）は別導線: `garnet --rt-stats`。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ $# -ge 1 ] || { echo "usage: scripts/profile_bench.sh <input.ts|binary> [args...]"; exit 1; }
in="$1"; shift
SECS="${TSAOT_PROFILE_SECS:-30}"
mkdir -p build/profiles

if [ ! -e "$in" ]; then echo "[profile] no such file: $in"; exit 1; fi
case "$in" in
  *.ts)
    base="$(basename "${in%.ts}")"
    echo "[profile] building with garnet --profile…"
    ./garnet --profile -o "build/profiles/$base.c" "$in" || exit 1
    bin="build/profiles/$base"
    ;;
  *)
    base="$(basename "$in")"
    bin="$in"
    ;;
esac

case "$(uname)" in
  Darwin)
    out="build/profiles/$base.sample.txt"
    "$bin" "$@" & pid=$!
    # sample はプロセス終了時点で自動終了する（SECS は上限）
    sample "$pid" "$SECS" -file "$out" >/dev/null 2>&1 &
    spid=$!
    wait "$pid"; rc=$?
    wait "$spid" 2>/dev/null || true
    echo "[profile] exit=$rc  wrote $out"
    echo "----- top of call graph -----"
    sed -n '/Call graph/,/^$/p' "$out" | head -25
    ;;
  Linux)
    out="build/profiles/$base.perf.data"
    perf record -g -o "$out" -- "$bin" "$@" || exit 1
    echo "[profile] wrote $out"
    perf report --stdio -i "$out" 2>/dev/null | head -30
    ;;
  *)
    echo "[profile] unsupported platform: $(uname)"; exit 1
    ;;
esac
