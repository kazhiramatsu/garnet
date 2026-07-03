#!/usr/bin/env bash
# Benchmark CI gate (batched).
# Pipeline per benchmark:
#   1. export TS -> program.json   (done ONCE for all benchmarks via --batch:
#      a single ts.Program amortizes the ~1.5s TS init + lib load that otherwise
#      repeated per file — ~23x faster export on 62 benchmarks)
#   2. analyze + emit C (tsaot analyzer)
#   3. gcc -O2 the C + precompiled ts_rt.o -> native binary
#   4. run it; assert stdout == expected            (CORRECTNESS gate)
#   5. measure wall-clock; assert <= aot_budget_ms   (REGRESSION gate)
# Exit nonzero on any correctness failure or budget overrun.
#
# Env knobs:
#   TSAOT_RUNS=N        number of timed runs, take the min (default 3)
#   TSAOT_NO_BUDGET=1   skip the time-budget gate (correctness only)
#   TSAOT_CC="gcc -O2"  override the C compiler/flags
#   TSAOT_USE_MIMALLOC=1 route runtime/generated malloc/free through mimalloc
#   TSAOT_MANIFEST=path use a different manifest (default benchmarks/manifest.tsv)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS="${TSAOT_RUNS:-3}"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/mimalloc_flags.sh" || exit 1
. "$ROOT/scripts/regexp_link_flags.sh" || exit 1
WORK="$(mktemp -d)"
ANALYZER="$ROOT/analyzer/target/release/tsaot"
EXPORTER="$ROOT/exporter/exporter.js"
RT="$ROOT/runtime"
MANIFEST="${TSAOT_MANIFEST:-$ROOT/benchmarks/manifest.tsv}"
FILTER="${1:-}"
fail=0

if [[ ! -x "$ANALYZER" ]]; then
  echo "[bench] building analyzer (release)"
  (cd "$ROOT/analyzer" && cargo build --release --quiet)
fi
if [[ ! -f "$EXPORTER" ]]; then
  echo "[bench] building exporter (tsc)"
  (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
      --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)
fi

now_ms() { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null \
        || perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' 2>/dev/null \
        || gdate +%s%3N 2>/dev/null \
        || date +%s%3N 2>/dev/null \
        || echo $(( $(date +%s) * 1000 )); }

RT_OBJ="$WORK/ts_rt.o"
if ! $CC -c "$RT/ts_rt.c" -I"$RT" -o "$RT_OBJ" 2>"$WORK/rt.cc.err"; then
  echo "[bench] FATAL: runtime ts_rt.c failed to compile"; cat "$WORK/rt.cc.err"; exit 1
fi

# --- STAGE 1: batch-export every (matching) benchmark in ONE node process ---
# The LIST carries name + srcpath + expected + budget on one TSV row, so the
# bench loop can read everything it needs without an associative array
# (declare -A is bash 4+ only; macOS ships bash 3.2).
LIST="$WORK/batch.tsv"
: > "$LIST"
while IFS=$'\t' read -r name source expected budget v8ref verdict; do
  [[ "$name" =~ ^#.*$ || -z "$name" ]] && continue
  [[ -n "$FILTER" ]] && ! [[ "$name" =~ ${FILTER} ]] && continue
  printf '%s\t%s\t%s\t%s\n' "$name" "$ROOT/benchmarks/$source" "$expected" "$budget" >> "$LIST"
done < "$MANIFEST"

if [[ ! -s "$LIST" ]]; then echo "[bench] no benchmarks matched filter '$FILTER'"; rm -rf "$WORK"; exit 0; fi

OUTDIR="$WORK/json"
exp_t0="$(now_ms)"
node "$EXPORTER" --batch "$LIST" "$OUTDIR" >"$WORK/batch.status" 2>"$WORK/batch.err"
exp_t1="$(now_ms)"
nbench="$(wc -l < "$LIST")"
echo "[bench] batch-exported $nbench benchmark(s) in $((exp_t1-exp_t0))ms"

printf "%-22s %-12s %-12s %-9s %-9s %s\n" "BENCHMARK" "RESULT" "EXPECTED" "TIME(ms)" "BUDGET" "STATUS"
printf -- "-------------------------------------------------------------------------------------\n"

while IFS=$'\t' read -r name srcpath expected budget; do
  prog="$OUTDIR/$name.program.json"
  cfile="$WORK/$name.c"; bin="$WORK/$name.bin"

  bstatus="$(awk -F'\t' -v n="$name" '$1==n{print $2}' "$WORK/batch.status")"
  if [[ "$bstatus" != "OK" || ! -f "$prog" ]]; then
    printf "%-22s %-12s %-12s %-9s %-9s %s\n" "$name" "-" "$expected" "-" "$budget" "EXPORT_${bstatus:-FAIL}"
    grep "\[$name\]" "$WORK/batch.err" | head -3; fail=1; continue
  fi
  if ! "$ANALYZER" "$prog" emit > "$cfile" 2>"$WORK/$name.an.err"; then
    printf "%-22s %-12s %-12s %-9s %-9s %s\n" "$name" "-" "$expected" "-" "$budget" "ANALYZE_FAIL"
    cat "$WORK/$name.an.err"; fail=1; continue
  fi
  if ! tsaot_prepare_regexp_objs "$cfile" "$WORK" 2>"$WORK/$name.rx.err"; then
    printf "%-22s %-12s %-12s %-9s %-9s %s\n" "$name" "-" "$expected" "-" "$budget" "REGEXP_LINK_PREP_FAIL"
    cat "$WORK/$name.rx.err"; fail=1; continue
  fi
  if ! tsaot_prepare_unicode_objs "$cfile" "$WORK" 2>"$WORK/$name.uc.err"; then
    printf "%-22s %-12s %-12s %-9s %-9s %s\n" "$name" "-" "$expected" "-" "$budget" "UNICODE_LINK_PREP_FAIL"
    cat "$WORK/$name.uc.err"; fail=1; continue
  fi
  if ! tsaot_prepare_fetch_runtime "$cfile" "$WORK" "$RT_OBJ" 2>"$WORK/$name.fetch.err"; then
    printf "%-22s %-12s %-12s %-9s %-9s %s\n" "$name" "-" "$expected" "-" "$budget" "FETCH_LINK_PREP_FAIL"
    cat "$WORK/$name.fetch.err"; fail=1; continue
  fi
  if ! $CC "$cfile" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$RT" -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS -o "$bin" 2>"$WORK/$name.cc.err"; then
    printf "%-22s %-12s %-12s %-9s %-9s %s\n" "$name" "-" "$expected" "-" "$budget" "COMPILE_FAIL"
    cat "$WORK/$name.cc.err"; fail=1; continue
  fi
  out="$("$bin" 2>/dev/null | head -1)"
  ok_correct=1; [[ "$out" == "$expected" ]] || ok_correct=0
  best=999999
  for ((r=0;r<RUNS;r++)); do
    t0="$(now_ms)"; "$bin" >/dev/null 2>&1; t1="$(now_ms)"
    dt=$((t1-t0)); (( dt<best )) && best=$dt
  done
  status="PASS"
  [[ $ok_correct -eq 0 ]] && { status="WRONG_OUTPUT"; fail=1; }
  if [[ "${TSAOT_NO_BUDGET:-0}" != "1" && $ok_correct -eq 1 ]]; then
    if (( best > budget )); then status="SLOW(>budget)"; fail=1; fi
  fi
  printf "%-22s %-12s %-12s %-9s %-9s %s\n" "$name" "$out" "$expected" "$best" "$budget" "$status"
done < "$LIST"

printf -- "-------------------------------------------------------------------------------------\n"
rm -rf "$WORK"
if [[ $fail -ne 0 ]]; then echo "[bench] FAILURES detected"; exit 1; fi
echo "[bench] all benchmarks correct and within budget"
