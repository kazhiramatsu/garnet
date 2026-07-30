#!/usr/bin/env bash
# bench_gc.sh — GC/アロケータの軽量ベンチ（低負荷方針対応・全体で数十秒）。
#
#   scripts/bench_gc.sh [--runs N] [name-filter]
#
# benchmarks/gc/*.ts を typed（rust analyzer）でコンパイルし、
#   1) 通常ビルドで wall 時間（best-of-N、各ベンチ ~1s 規模）
#   2) RT_STATS ビルドで GC 統計（minor/full 回数・pause 合計/最大・alloc・
#      map_find / find_prop プローブ・closure malloc）
# を収集して build/bench_history/<UTC>_gc.json に蓄積する。
#
# GC 改善（P2a/P6）の判断プロトコル:
#   - 回数・alloc 量・プローブ長は決定的カウンタ → 負荷にほぼ非依存で信頼可
#   - wall / pause は時間系 → A/B は必ず交互実行で: 旧 rt.o と新 rt.o を
#     TSAOT_RT_OBJ=<stats build の rt.o> 差し替えで同条件 ABAB 比較する
#     （GC 内部の変更は ABI 不変なので生成 C は共有できる）
#   - 重い gate gc（threshold=1 + ASan の correctness 網羅）とは役割分担:
#     こちらは「速さ」、あちらは「正しさ」。
#
# Env: TSAOT_RUNS=N (default 3), TSAOT_RT_OBJ=path（stats rt.o の差し替え・A/B 用）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUNS="${TSAOT_RUNS:-3}"
FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) shift; RUNS="${1:?--runs needs N}" ;;
    *) FILTER="$1" ;;
  esac
  shift
done

RUST="$ROOT/analyzer/target/release/tsaot"
[ -x "$RUST" ] || { echo "[bench_gc] Rust analyzer not built"; exit 1; }
[ -f "$ROOT/exporter/exporter.js" ] || { echo "[bench_gc] exporter not built"; exit 1; }

W="$ROOT/build/gcbench"; mkdir -p "$W"
HIST="$ROOT/build/bench_history"; mkdir -p "$HIST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ランタイム 2 種（通常 / stats）。TSAOT_RT_OBJ は stats 側の差し替え（A/B 用）。
RT_PLAIN="$W/rt_plain.o"
if [ ! -f "$RT_PLAIN" ] ||
   [ "$ROOT/runtime/ts_rt.c" -nt "$RT_PLAIN" ] ||
   [ "$ROOT/runtime/ts_rt.h" -nt "$RT_PLAIN" ]; then
  cc -O2 -c runtime/ts_rt.c -Iruntime -o "$RT_PLAIN" || exit 1
fi
RT_STATS="${TSAOT_RT_OBJ:-$W/rt_stats.o}"
if [ -z "${TSAOT_RT_OBJ:-}" ] &&
   { [ ! -f "$RT_STATS" ] ||
     [ "$ROOT/runtime/ts_rt.c" -nt "$RT_STATS" ] ||
     [ "$ROOT/runtime/ts_rt.h" -nt "$RT_STATS" ]; }; then
  cc -O2 -DTSAOT_RT_STATS -c runtime/ts_rt.c -Iruntime -o "$RT_STATS" || exit 1
fi

. "$ROOT/scripts/lib/now_ms.sh"

stat_of() { # $1=stats stderr file  $2=sed regex → 値 or "-"
  sed -n -E "s/.*$2.*/\1/p" "$1" | head -1
}

printf "%-18s %8s %7s %6s %9s %10s %9s %9s %9s %9s %7s %12s %10s %10s %10s %10s %10s %12s %12s\n" \
  "BENCH" "WALL_MS" "MINOR" "FULL" "PAUSE_MS" "MAXP_MS" "ALLOC_MB" "AGE_CP" "AGE_DIE" "AGE_PROM" "AGE_FB" "MAPF_PROBE" "SB_EXTEND" "SB_FRESH" "SB_FLAT" "SHORT" "ENV_MALLOC" "ROOT_PUSH" "FRAME_PUSH"
printf -- "-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\n"

rows=""; fail=0
for ts in benchmarks/gc/*.ts; do
  name="$(basename "${ts%.ts}")"
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) continue ;; esac

  # export + emit（typed）
  node exporter/exporter.js "$ts" "$W/$name.ir.json" "$W/$name.l.json" >/dev/null 2>&1 \
    || { echo "$name: EXPORT_FAIL"; fail=1; continue; }
  "$RUST" "$W/$name.ir.json" emit > "$W/$name.c" 2>/dev/null \
    || { echo "$name: EMIT_FAIL"; fail=1; continue; }
  if grep -q '^#define TSAOT_NEEDS_' "$W/$name.c"; then
    echo "$name: FIXTURE_HAS_DEPS (gc fixtures must stay regexp/unicode/fetch-free)"; fail=1; continue
  fi
  cc -O2 "$W/$name.c" "$RT_PLAIN" -Iruntime -lm -o "$W/$name" 2>"$W/$name.cc.err" \
    || { echo "$name: CC_FAIL"; head -2 "$W/$name.cc.err"; fail=1; continue; }
  cc -O2 -DTSAOT_RT_STATS "$W/$name.c" "$RT_STATS" -Iruntime -lm -o "$W/${name}_stats" 2>/dev/null \
    || { echo "$name: CC_STATS_FAIL"; fail=1; continue; }

  # 1) wall（通常ビルド・best-of-N）
  best=99999999
  out_expected=""
  for ((r=0; r<RUNS; r++)); do
    t0=$(now_ms); out="$("$W/$name" 2>/dev/null)"; t1=$(now_ms)
    dt=$((t1-t0)); [ "$dt" -lt "$best" ] && best=$dt
    [ -z "$out_expected" ] && out_expected="$out"
    [ "$out" = "$out_expected" ] || { echo "$name: NONDETERMINISTIC_OUTPUT"; fail=1; }
  done

  # 2) GC 統計（stats ビルド・1 回）
  serr="$W/$name.stats.txt"
  "$W/${name}_stats" >/dev/null 2>"$serr" || { echo "$name: STATS_RUN_FAIL"; fail=1; continue; }
  minor=$(stat_of "$serr" 'minor=([0-9]+)')
  full=$(stat_of "$serr" ' full=([0-9]+)')
  pause=$(stat_of "$serr" 'pause_ms=([0-9.]+)')
  maxp=$(stat_of "$serr" 'max_pause_ms=([0-9.]+)')
  alloc_b=$(stat_of "$serr" 'bytes=([0-9]+)')
  mapf=$(stat_of "$serr" 'map_find: calls=[0-9]+ avg_probe=([0-9.]+)')
  sbext=$(stat_of "$serr" 'string_builder: extend=([0-9]+)')
  sbfresh=$(stat_of "$serr" ' fresh=([0-9]+)')
  sbflat=$(stat_of "$serr" ' flat=([0-9]+)')
  short=$(stat_of "$serr" ' short=([0-9]+)')
  envm=$(stat_of "$serr" 'env_malloc=([0-9]+)')
  rootp=$(stat_of "$serr" 'root_push=([0-9]+)')
  framep=$(stat_of "$serr" 'frame_push=([0-9]+)')
  agecopy=$(stat_of "$serr" 'aging: copied_bytes=([0-9]+)')
  agedie=$(stat_of "$serr" 'died_bytes=([0-9]+)')
  ageprom=$(stat_of "$serr" 'promoted_bytes=([0-9]+)')
  agefb=$(stat_of "$serr" 'fallback_minors=([0-9]+)')
  alloc_mb=$(awk "BEGIN{printf \"%.1f\", ${alloc_b:-0}/1e6}" 2>/dev/null || echo "-")
  agecopy_mb=$(awk "BEGIN{printf \"%.1f\", ${agecopy:-0}/1e6}" 2>/dev/null || echo "-")
  agedie_mb=$(awk "BEGIN{printf \"%.1f\", ${agedie:-0}/1e6}" 2>/dev/null || echo "-")
  ageprom_mb=$(awk "BEGIN{printf \"%.1f\", ${ageprom:-0}/1e6}" 2>/dev/null || echo "-")

  printf "%-18s %8s %7s %6s %9s %10s %9s %9s %9s %9s %7s %12s %10s %10s %10s %10s %10s %12s %12s\n" \
    "$name" "$best" "${minor:--}" "${full:--}" "${pause:--}" "${maxp:--}" "$alloc_mb" "$agecopy_mb" "$agedie_mb" "$ageprom_mb" "${agefb:--}" "${mapf:--}" "${sbext:--}" "${sbfresh:--}" "${sbflat:--}" "${short:--}" "${envm:--}" "${rootp:--}" "${framep:--}"
  [ -n "$rows" ] && rows="$rows,"
  rows="$rows
    {\"name\":\"$name\",\"wall_ms\":$best,\"minor\":${minor:-0},\"full\":${full:-0},\"pause_ms\":${pause:-0},\"max_pause_ms\":${maxp:-0},\"alloc_bytes\":${alloc_b:-0},\"aging_copied_bytes\":${agecopy:-0},\"aging_died_bytes\":${agedie:-0},\"aging_promoted_bytes\":${ageprom:-0},\"aging_fallback_minors\":${agefb:-0},\"map_find_avg_probe\":${mapf:-0},\"sb_extend\":${sbext:-0},\"sb_fresh\":${sbfresh:-0},\"sb_flat\":${sbflat:-0},\"short_string\":${short:-0},\"env_malloc\":${envm:-0},\"root_push\":${rootp:-0},\"frame_push\":${framep:-0}}"
done

printf -- "-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\n"
OUT="$HIST/${STAMP}_gc.json"
cat > "$OUT" <<EOF
{
  "date": "$STAMP",
  "host": "$(uname -sm)",
  "runs": $RUNS,
  "rt_obj": "$([ -n "${TSAOT_RT_OBJ:-}" ] && echo "override:$TSAOT_RT_OBJ" || echo default)",
  "results": [$rows
  ]
}
EOF
echo "[bench_gc] wrote $OUT"
exit $fail
