#!/usr/bin/env bash
# Conformance harness: compile each .ts BOTH with tsaot (AOT) and via type-strip
# (V8), and assert identical stdout. V8 is the oracle — no hand-maintained
# expected values. Adding a test = dropping a .ts file under the tier dir.
#
# Usage:  run_conformance.sh <tier> [name-filter-regex]
#   tier = basic | exhaustive | all
# Tiers live under tests/conformance/<tier>/**/*.ts (recursive).
#
# Speed: ALL exports happen in ONE node process (shared lib-file cache, per-file
# isolated Program) and ALL V8 refs in ONE transpile process. Runtime compiled
# once. This keeps even thousands of cases practical on a single core.
#
# Env:  TSAOT_CONF_SHARD="i/n"  run only shard i of n (1-indexed) for distribution
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIER="${1:-basic}"
FILTER="${2:-}"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
. "$ROOT/scripts/lib/regexp_link_flags.sh" || exit 1
EX="$ROOT/exporter/exporter.js"
TSAOT="$ROOT/analyzer/target/release/tsaot"
RT="$ROOT/runtime"
WORK="$(mktemp -d)"
fail=0; npass=0; nfail=0

[[ -x "$TSAOT" ]] || (cd "$ROOT/analyzer" && cargo build --release --quiet) || { echo "analyzer build FAILED"; exit 1; }
[[ -f "$EX" ]] || (cd "$ROOT/exporter" && ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop) || { echo "exporter build FAILED"; exit 1; }

# collect test files for the tier(s)
dirs=()
case "$TIER" in
  basic)      dirs=("$ROOT/tests/conformance/basic");;
  exhaustive) dirs=("$ROOT/tests/conformance/exhaustive");;
  all)        dirs=("$ROOT/tests/conformance/basic" "$ROOT/tests/conformance/exhaustive");;
  *) echo "unknown tier '$TIER' (use basic|exhaustive|all)"; exit 1;;
esac

mapfile_compat() { eval "$1=()"; local _l; while IFS= read -r _l; do eval "$1+=(\"\$_l\")"; done; }
mapfile_compat allts < <(for d in "${dirs[@]}"; do [[ -d "$d" ]] && find "$d" -name '*.ts' | sort; done)
# optional name filter
if [[ -n "$FILTER" ]]; then
  filtered=(); for f in "${allts[@]}"; do n=$(basename "$f" .ts); [[ "$n" =~ ${FILTER} ]] && filtered+=("$f"); done
  allts=("${filtered[@]}")
fi
# optional sharding for distribution across runs (i/n)
if [[ -n "${TSAOT_CONF_SHARD:-}" ]]; then
  si="${TSAOT_CONF_SHARD%/*}"; sn="${TSAOT_CONF_SHARD#*/}"
  sharded=(); idx=0
  for f in "${allts[@]}"; do (( idx % sn == si-1 )) && sharded+=("$f"); idx=$((idx+1)); done
  allts=("${sharded[@]}")
fi

ntotal=${#allts[@]}
if (( ntotal == 0 )); then echo "[conf:$TIER] no tests matched"; rm -rf "$WORK"; exit 0; fi

# build the batch list (name = path-relative slug to avoid collisions across dirs)
LIST="$WORK/list.tsv"; : > "$LIST"
for f in "${allts[@]}"; do
  rel="${f#$ROOT/tests/conformance/}"; slug="${rel%.ts}"; slug="${slug//\//__}"
  printf '%s\t%s\n' "$slug" "$f" >> "$LIST"
done

# runtime once
RT_OBJ="$WORK/ts_rt.o"
$CC -c "$RT/ts_rt.c" -I"$RT" -o "$RT_OBJ" 2>"$WORK/rt.err" || { echo "[conf] runtime compile FAILED"; cat "$WORK/rt.err"; exit 1; }

# portable millisecond clock (macOS BSD date lacks %3N; %N also unsupported).
. "$ROOT/scripts/lib/now_ms.sh"

# batch export (AOT IR) + batch transpile (V8 ref), each in one node process
t0=$(now_ms)
node "$EX" --batch "$LIST" "$WORK/json" >"$WORK/exp.status" 2>"$WORK/exp.err" || true
node "$EX" --transpile-batch "$LIST" "$WORK/v8" >"$WORK/tr.status" 2>"$WORK/tr.err" || true
t1=$(now_ms)
echo "[conf:$TIER] $ntotal tests | export+transpile ${ntotal} in $((t1-t0))ms"

while IFS=$'\t' read -r slug path; do
  prog="$WORK/json/$slug.program.json"; jsref="$WORK/v8/$slug.js"
  estatus="$(awk -F'\t' -v n="$slug" '$1==n{print $2}' "$WORK/exp.status")"
  if [[ "$estatus" != "OK" || ! -f "$prog" ]]; then
    echo "[conf] FAIL ${slug}: export ${estatus:-?}"; grep "\[$slug\]" "$WORK/exp.err" | head -2; nfail=$((nfail+1)); fail=1; continue
  fi
  v8="$(node "$jsref" 2>&1 | tr '\n' '|')"
  "$TSAOT" "$prog" emit > "$WORK/$slug.c" 2>"$WORK/$slug.an.err" || { echo "[conf] FAIL ${slug}: analyze"; cat "$WORK/$slug.an.err"|head -2; nfail=$((nfail+1)); fail=1; continue; }
  if ! tsaot_prepare_regexp_objs "$WORK/$slug.c" "$WORK" 2>"$WORK/$slug.rx.err"; then
    echo "[conf] FAIL ${slug}: regexp-link-prep"; head -3 "$WORK/$slug.rx.err"; nfail=$((nfail+1)); fail=1; continue
  fi
  if ! tsaot_prepare_unicode_objs "$WORK/$slug.c" "$WORK" 2>"$WORK/$slug.uc.err"; then
    echo "[conf] FAIL ${slug}: unicode-link-prep"; head -3 "$WORK/$slug.uc.err"; nfail=$((nfail+1)); fail=1; continue
  fi
  if ! tsaot_prepare_fetch_runtime "$WORK/$slug.c" "$WORK" "$RT_OBJ" 2>"$WORK/$slug.fetch.err"; then
    echo "[conf] FAIL ${slug}: fetch-link-prep"; head -3 "$WORK/$slug.fetch.err"; nfail=$((nfail+1)); fail=1; continue
  fi
  if ! $CC "$WORK/$slug.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$RT" -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS -o "$WORK/$slug.bin" 2>"$WORK/$slug.cc.err"; then
    echo "[conf] FAIL ${slug}: gcc"; head -3 "$WORK/$slug.cc.err"; nfail=$((nfail+1)); fail=1; continue
  fi
  aot="$("$WORK/$slug.bin" 2>&1 | tr '\n' '|')"
  if [[ "$aot" == "$v8" ]]; then
    npass=$((npass+1))
    [[ -n "${TSAOT_CONF_VERBOSE:-}" ]] && echo "[conf] PASS ${slug}  ($aot)"
  else
    echo "[conf] FAIL ${slug}: AOT=[$aot] V8=[$v8]"; nfail=$((nfail+1)); fail=1
  fi
done < "$LIST"

rm -rf "$WORK"
echo "[conf:$TIER] PASS=$npass FAIL=$nfail / $ntotal"
exit $fail
