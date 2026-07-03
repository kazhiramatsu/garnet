#!/usr/bin/env bash
# tsc_conformance harness — feed microsoft/TypeScript tests/cases/conformance/
# tests into tsaot. Two modes:
#
#   runtime: full pipeline (export -> emit C -> gcc -> run), compare stdout to V8
#            Outcomes: PASS, FAIL, REJECTED (unsupported, counted separately).
#   loud:    exporter only; OK or UNSUPPORTED are passes, ERROR (crash) is a FAIL.
#            (No C compile/run — these tests don't have a runtime-compare oracle.)
#
# Usage:
#   run_tsc_conformance.sh <ts-root> <mode> [name-filter-regex]
#
# Env:
#   TSAOT_TSC_BUDGET_MS=60000   # total wall budget for the batch exporter (default 60s)
#   TSAOT_CONF_VERBOSE=1        # print per-test outcomes
#
# Notes:
#   - This harness lives alongside `run_conformance.sh`. It does NOT touch the
#     in-tree `basic` / `exhaustive` tiers. Test inputs live OUTSIDE tsaot/
#     (we don't bundle ms/TypeScript into our zip).
#   - The exporter's batch loop already handles per-file UNSUPPORTED and
#     ERROR isolation; one bad test doesn't kill the batch. We wrap the whole
#     batch in `timeout` defensively in case of a true hang.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_ROOT="${1:?usage: run_tsc_conformance.sh <ts-root> <mode> [filter]}"
MODE="${2:?usage: run_tsc_conformance.sh <ts-root> <mode> [filter]}"
FILTER="${3:-}"
BUDGET_MS="${TSAOT_TSC_BUDGET_MS:-60000}"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
. "$ROOT/scripts/lib/regexp_link_flags.sh" || exit 1

EX="$ROOT/exporter/exporter.js"
TSAOT="$ROOT/analyzer/target/release/tsaot"
RT="$ROOT/runtime"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -x "$TSAOT" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet) || { echo "analyzer build FAILED"; exit 1; }
[[ -f "$EX" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) || { echo "exporter build FAILED"; exit 1; }

# Build the test list via the filter helper
LIST="$WORK/list.tsv"
bash "$ROOT/scripts/list_tsc_tests.sh" "$TS_ROOT" "$MODE" > "$LIST" 2>"$WORK/list.err"
if [[ ! -s "$LIST" ]]; then
  echo "[tscconf:$MODE] no tests matched"
  [[ -s "$WORK/list.err" ]] && head "$WORK/list.err" >&2
  exit 0
fi

# Apply optional name-filter regex
if [[ -n "$FILTER" ]]; then
  awk -F'\t' -v re="$FILTER" '$1 ~ re' "$LIST" > "$LIST.f" && mv "$LIST.f" "$LIST"
fi
ntotal=$(wc -l < "$LIST")
(( ntotal == 0 )) && { echo "[tscconf:$MODE] filter '$FILTER' matched nothing"; exit 0; }

# Compile runtime once (only used in runtime mode, but cheap)
RT_OBJ="$WORK/ts_rt.o"
$CC -c "$RT/ts_rt.c" -I"$RT" -o "$RT_OBJ" 2>"$WORK/rt.err" || { echo "[tscconf] runtime compile FAILED"; cat "$WORK/rt.err"; exit 1; }

# portable millisecond clock (macOS BSD date lacks %3N).
now_ms() { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null \
        || perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' 2>/dev/null \
        || gdate +%s%3N 2>/dev/null \
        || date +%s%3N 2>/dev/null \
        || echo $(( $(date +%s) * 1000 )); }

# portable timeout: GNU `timeout` (Linux) or `gtimeout` (macOS via brew coreutils).
# If neither is present, run without a wall-clock cap (the script still works,
# just no batch-level hang protection).
timeout_cmd() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"
  else shift; "$@"; fi
}

# --- batch export (with whole-batch timeout to guard against hangs) ---
t0=$(now_ms)
budget_s=$(( BUDGET_MS / 1000 ))
mkdir -p "$WORK/json"
timeout_cmd "${budget_s}s" node "$EX" --batch "$LIST" "$WORK/json" > "$WORK/exp.status" 2> "$WORK/exp.err"
exp_rc=$?
t1=$(now_ms)

if (( exp_rc == 124 )); then
  echo "[tscconf:$MODE] BATCH TIMED OUT after ${budget_s}s — partial results, treating remaining as TIMEOUT"
fi
echo "[tscconf:$MODE] $ntotal tests | export in $((t1-t0))ms (rc=$exp_rc)"

# --- runtime mode: also batch the V8 reference transpile ---
if [[ "$MODE" == "runtime" ]]; then
  mkdir -p "$WORK/v8"
  timeout_cmd "${budget_s}s" node "$EX" --transpile-batch "$LIST" "$WORK/v8" > "$WORK/tr.status" 2> "$WORK/tr.err" || true
fi

# --- iterate results ---
nok=0; nuns=0; nerr=0; nfail=0; npass=0; nreject=0; ncrash=0; ntmo=0
while IFS=$'\t' read -r slug path; do
  [[ -z "$slug" ]] && continue
  estatus="$(awk -F'\t' -v n="$slug" '$1==n{print $2; exit}' "$WORK/exp.status")"
  if [[ -z "$estatus" ]]; then estatus="TIMEOUT"; fi

  if [[ "$MODE" == "loud" ]]; then
    case "$estatus" in
      OK)          nok=$((nok+1));;
      UNSUPPORTED) nuns=$((nuns+1));;
      ERROR)       ncrash=$((ncrash+1));
                   reason="$(grep -m1 "\[$slug\]" "$WORK/exp.err" | sed "s|.*\[$slug\] ||" | head -c 200)"
                   echo "[tscconf:loud] CRASH $slug: $reason";;
      TIMEOUT)     ntmo=$((ntmo+1));;
      *)           ncrash=$((ncrash+1)); echo "[tscconf:loud] UNKNOWN-STATUS $slug: $estatus";;
    esac
    continue
  fi

  # runtime mode
  if [[ "$estatus" == "UNSUPPORTED" ]]; then
    nreject=$((nreject+1))
    [[ -n "${TSAOT_CONF_VERBOSE:-}" ]] && echo "[tscconf:runtime] REJECTED $slug"
    continue
  fi
  if [[ "$estatus" != "OK" ]]; then
    nfail=$((nfail+1))
    echo "[tscconf:runtime] FAIL $slug: export $estatus"
    continue
  fi
  prog="$WORK/json/$slug.program.json"
  jsref="$WORK/v8/$slug.js"
  [[ -f "$prog" && -f "$jsref" ]] || { nfail=$((nfail+1)); echo "[tscconf:runtime] FAIL $slug: missing artifacts"; continue; }

  # V8 reference output. node may itself crash on unsupported runtime features
  # (some conformance tests use Symbol, Promise, etc.); treat that as REJECTED.
  v8=$(timeout 5s node "$jsref" 2>&1 | tr '\n' '|')
  v8_rc=$?
  if (( v8_rc == 124 )); then
    nreject=$((nreject+1))
    [[ -n "${TSAOT_CONF_VERBOSE:-}" ]] && echo "[tscconf:runtime] REJECTED $slug (V8 timeout)"
    continue
  fi

  # tsaot pipeline
  if ! "$TSAOT" "$prog" emit > "$WORK/$slug.c" 2>"$WORK/$slug.an.err"; then
    nfail=$((nfail+1))
    echo "[tscconf:runtime] FAIL $slug: analyzer"
    head -2 "$WORK/$slug.an.err" >&2
    continue
  fi
  if ! tsaot_prepare_regexp_objs "$WORK/$slug.c" "$WORK" 2>"$WORK/$slug.rx.err"; then
    nfail=$((nfail+1))
    echo "[tscconf:runtime] FAIL $slug: regexp-link-prep"
    head -3 "$WORK/$slug.rx.err" >&2
    continue
  fi
  if ! tsaot_prepare_unicode_objs "$WORK/$slug.c" "$WORK" 2>"$WORK/$slug.uc.err"; then
    nfail=$((nfail+1))
    echo "[tscconf:runtime] FAIL $slug: unicode-link-prep"
    head -3 "$WORK/$slug.uc.err" >&2
    continue
  fi
  if ! tsaot_prepare_fetch_runtime "$WORK/$slug.c" "$WORK" "$RT_OBJ" 2>"$WORK/$slug.fetch.err"; then
    nfail=$((nfail+1))
    echo "[tscconf:runtime] FAIL $slug: fetch-link-prep"
    head -3 "$WORK/$slug.fetch.err" >&2
    continue
  fi
  if ! $CC "$WORK/$slug.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$RT" -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS -o "$WORK/$slug.bin" 2>"$WORK/$slug.cc.err"; then
    nfail=$((nfail+1))
    echo "[tscconf:runtime] FAIL $slug: gcc"
    head -3 "$WORK/$slug.cc.err" >&2
    continue
  fi
  aot=$(timeout 5s "$WORK/$slug.bin" 2>&1 | tr '\n' '|')
  aot_rc=$?
  if (( aot_rc == 124 )); then
    nfail=$((nfail+1)); echo "[tscconf:runtime] FAIL $slug: AOT hung"; continue
  fi
  if [[ "$aot" == "$v8" ]]; then
    npass=$((npass+1))
    [[ -n "${TSAOT_CONF_VERBOSE:-}" ]] && echo "[tscconf:runtime] PASS $slug"
  else
    nfail=$((nfail+1))
    echo "[tscconf:runtime] FAIL $slug: AOT=[$aot] V8=[$v8]"
  fi
done < "$LIST"

# --- summary ---
echo
if [[ "$MODE" == "loud" ]]; then
  total=$((nok+nuns+ncrash+ntmo))
  echo "[tscconf:loud] OK=$nok  UNSUPPORTED=$nuns  CRASH=$ncrash  TIMEOUT=$ntmo  / $total"
  # FAIL semantics: any CRASH or TIMEOUT is a real bug.
  (( ncrash == 0 && ntmo == 0 )) && exit 0 || exit 1
else
  total=$((npass+nfail+nreject))
  echo "[tscconf:runtime] PASS=$npass  FAIL=$nfail  REJECTED=$nreject  / $total"
  (( nfail == 0 )) && exit 0 || exit 1
fi
