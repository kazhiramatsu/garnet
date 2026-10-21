#!/usr/bin/env bash
# Conformance driver for the frozen/self-hosting TypeScript analyzer.
#
# The expensive front-end phases are batched into one process each:
#   exporter --batch -> analyzer_ts --batch -> V8 transpile --batch
# Native compilation/linking and the isolated V8/native executions still happen
# per fixture, but run concurrently.  Isolation is intentional: conformance
# programs may mutate global built-ins and must not contaminate the next case.
#
# Env:
#   TSAOT_SELFCONF_JOBS=N   native/oracle workers (default: min(CPU count, 8))
#   TSAOT_SELFCONF_CACHE=0  disable the generated-native cache under build/
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-cc -O2}"
EXPORTER="$ROOT/exporter/exporter.js"
FILTER="${1:-}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export ROOT CC
. "$ROOT/scripts/lib/mimalloc_flags.sh" 2>/dev/null || exit 1
. "$ROOT/scripts/lib/regexp_link_flags.sh" || { echo "regexp link flags missing"; exit 1; }
. "$ROOT/scripts/lib/now_ms.sh"

selfconf_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

mkdir -p "$tmp/json" "$tmp/c" "$tmp/v8" "$tmp/results"
SELFCONF_CACHE="${TSAOT_SELFCONF_CACHE:-1}"
SELFCONF_CACHE_DIR="${TSAOT_SELFCONF_CACHE_DIR:-$ROOT/build/selfconf-cache}"
SELFCONF_SUPPORT_KEY=""
if [[ "$SELFCONF_CACHE" != "0" ]]; then
  mkdir -p "$SELFCONF_CACHE_DIR"
  # Hash sources instead of the freshly compiled temporary rt.o: some object
  # formats embed output-path metadata, which would defeat reuse across runs.
  SELFCONF_SUPPORT_KEY=$(
    {
      find "$ROOT/runtime" -type f \( -name '*.c' -o -name '*.h' \) | sort |
        while IFS= read -r dep; do selfconf_sha256 "$dep"; done
      printf '%s\n' "$CC" "${TSAOT_LDLIBS:-}" "$(uname -srm)"
    } | selfconf_sha256 | awk '{print $1}'
  )
fi
LIST="$tmp/list.tsv"
: > "$LIST"
while IFS= read -r ts; do
  case "$ts" in *"$FILTER"*) ;; *) continue ;; esac
  name="${ts#tests/conformance/exhaustive/}"
  slug="${name%.ts}"
  slug="${slug//\//__}"
  printf '%s\t%s\n' "$slug" "$ROOT/$ts" >> "$LIST"
done < <(find tests/conformance/exhaustive -name "*.ts" | sort)

total=$(wc -l < "$LIST" | tr -d ' ')
if [[ "$total" == "0" ]]; then
  echo "==================== analyzer_ts conformance ===================="
  echo "total=0  PASS=0  UNPORTED=0  CCFAIL=0  DIFF=0  KNOWN=0  EXPORTER-skip=0"
  exit 0
fi

# 凍結双子との既知差分（Rust 側で修正済みの silent miscompile を凍結側はまだ持つ
# fixture。scripts/frozen_known_diffs.tsv の scope=selfconf 行）。
KNOWN_NAMES=$(awk -F'\t' '$1=="selfconf"{print $2}' "$ROOT/scripts/frozen_known_diffs.tsv" 2>/dev/null)
KNOWN_UNPORTED_NAMES=$(awk -F'\t' '$1=="selfconf-unported"{print $2}' "$ROOT/scripts/frozen_known_diffs.tsv" 2>/dev/null)

pass=0
unported=0
ccfail=0
diff=0
known=0
expfail=0
cache_hit=0
cache_miss=0
cache_off=0
: > "$tmp/unported.txt"
: > "$tmp/ccfail.txt"
: > "$tmp/diff.txt"
: > "$tmp/known.txt"
: > "$tmp/an.list.tsv"
: > "$tmp/run.list.tsv"

# Compile the shared runtime once. Optional RegExp/Unicode/fetch objects are also
# cached below before workers start, preventing duplicate-build races.
$CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$tmp/rt.o" 2>"$tmp/rt.err" ||
  { echo "runtime build failed"; head -5 "$tmp/rt.err"; exit 1; }

t0=$(now_ms)
# (the frozen emitter copies class prototypes and knows no instanceof.class:N)
TSAOT_UNTYPED=1 TSAOT_SHARED_CLASS_PROTO=0 TSAOT_INSTANCEOF_CLASS=0 TSAOT_CLOSED_RECEIVERS=0 TSAOT_METHOD_ESCAPES=0 node "$EXPORTER" --batch "$LIST" "$tmp/json" \
  >"$tmp/exp.status" 2>"$tmp/exp.err" || true
node "$EXPORTER" --transpile-batch "$LIST" "$tmp/v8" \
  >"$tmp/tr.status" 2>"$tmp/tr.err" || true

while IFS=$'\t' read -r slug path; do
  estatus=$(awk -F'\t' -v n="$slug" '$1==n{print $2; exit}' "$tmp/exp.status")
  if [[ "$estatus" == "OK" && -f "$tmp/json/$slug.program.json" ]]; then
    printf '%s\t%s\n' "$slug" "$tmp/json/$slug.program.json" >> "$tmp/an.list.tsv"
  fi
done < "$LIST"

node "$ROOT/analyzer_ts/dist/main.js" --batch "$tmp/an.list.tsv" "$tmp/c" emit \
  >"$tmp/an.status" 2>"$tmp/an.err" || true
t1=$(now_ms)
echo "[selfconf] $total tests | batch export+transpile+analyze $((t1-t0))ms"

# Classify front-end failures and make the worker list.  The fourth field marks
# allowlisted runtime differences so workers do not need shared shell state.
while IFS=$'\t' read -r slug path; do
  name="${path#"$ROOT/tests/conformance/exhaustive/"}"
  logical="${name%.ts}"
  estatus=$(awk -F'\t' -v n="$slug" '$1==n{print $2; exit}' "$tmp/exp.status")
  tstatus=$(awk -F'\t' -v n="$slug" '$1==n{print $2; exit}' "$tmp/tr.status")
  if [[ "$estatus" != "OK" || "$tstatus" != "OK" ]]; then
    expfail=$((expfail+1))
    continue
  fi
  astatus=$(awk -F'\t' -v n="$slug" '$1==n{print $2; exit}' "$tmp/an.status")
  areason=$(awk -F'\t' -v n="$slug" '$1==n{$1=$2=""; sub(/^[[:space:]]+/, ""); print; exit}' "$tmp/an.status")
  if [[ "$astatus" == "UNPORTED" ]]; then
    if printf '%s\n' "$KNOWN_UNPORTED_NAMES" | grep -qx "$logical"; then
      known=$((known+1))
      echo "$name (known UNPORTED: $areason)" >> "$tmp/known.txt"
    else
      unported=$((unported+1))
      echo "$areason" >> "$tmp/unported.txt"
    fi
    continue
  fi
  if [[ "$astatus" != "OK" || ! -f "$tmp/c/$slug.c" ]]; then
    ccfail=$((ccfail+1))
    echo "$name: analyzer ${areason:-failed}" >> "$tmp/ccfail.txt"
    continue
  fi
  is_known=0
  if printf '%s\n' "$KNOWN_NAMES" | grep -qx "$logical"; then is_known=1; fi
  printf '%s\t%s\t%s\t%s\n' "$slug" "$path" "$name" "$is_known" >> "$tmp/run.list.tsv"
done < "$LIST"

# Warm every optional support object before parallel linking. Helpers are then
# read-only in the workers and cannot race while producing a cached object.
while IFS=$'\t' read -r slug _path _name _known; do
  cfile="$tmp/c/$slug.c"
  tsaot_prepare_regexp_objs "$cfile" "$tmp" >/dev/null 2>&1 || { echo "regexp support build failed"; exit 1; }
  tsaot_prepare_unicode_objs "$cfile" "$tmp" >/dev/null 2>&1 || { echo "unicode support build failed"; exit 1; }
  tsaot_prepare_fetch_runtime "$cfile" "$tmp" "$tmp/rt.o" >/dev/null 2>&1 || { echo "fetch runtime build failed"; exit 1; }
done < "$tmp/run.list.tsv"

jobs="${TSAOT_SELFCONF_JOBS:-}"
if [[ -z "$jobs" ]]; then
  jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
  [[ "$jobs" =~ ^[0-9]+$ ]] || jobs=4
  (( jobs > 8 )) && jobs=8
  (( jobs < 1 )) && jobs=1
fi

run_selfconf_case() {
  local slug="$1"
  local _path="$2"
  local name="$3"
  local is_known="$4"
  local cfile="$TSAOT_SELFCONF_TMP/c/$slug.c"
  local bin="$TSAOT_SELFCONF_TMP/$slug.bin"
  local jsref="$TSAOT_SELFCONF_TMP/v8/$slug.js"
  local result="$TSAOT_SELFCONF_TMP/results/$slug.status"

  # Recompute only the argument lists. Parent warmup guarantees object files
  # already exist, so these helpers perform no concurrent writes.
  . "$ROOT/scripts/lib/regexp_link_flags.sh"
  tsaot_prepare_regexp_objs "$cfile" "$TSAOT_SELFCONF_TMP" >/dev/null 2>&1 ||
    { printf 'CCFAIL\t%s\tregexp support\n' "$name" > "$result"; return; }
  tsaot_prepare_unicode_objs "$cfile" "$TSAOT_SELFCONF_TMP" >/dev/null 2>&1 ||
    { printf 'CCFAIL\t%s\tunicode support\n' "$name" > "$result"; return; }
  tsaot_prepare_fetch_runtime "$cfile" "$TSAOT_SELFCONF_TMP" "$TSAOT_SELFCONF_TMP/rt.o" >/dev/null 2>&1 ||
    { printf 'CCFAIL\t%s\tfetch support\n' "$name" > "$result"; return; }

  # Cache the fully linked fixture binary. The key is content-addressed over the
  # generated C, every linked object, the public runtime header, compiler flags,
  # and platform. A second unchanged full run therefore skips hundreds of
  # identical C compiler/linker invocations while still running fresh isolated
  # native and V8 processes.
  local cached=""
  local cached_key=""
  local cache_state="off"
  if [[ "$TSAOT_SELFCONF_CACHE" != "0" ]]; then
    local cache_key dep
    cache_key=$(
      {
        printf '%s\n' "$TSAOT_SELFCONF_SUPPORT_KEY" "$CC" "$TSAOT_FETCH_LDLIBS" "${TSAOT_LDLIBS:-}"
        for dep in "$cfile" ${TSAOT_LDLIBS:-}; do
          [[ -f "$dep" ]] && selfconf_sha256 "$dep" | awk '{print $1}'
        done
      } | selfconf_sha256 | awk '{print $1}'
    )
    # One bounded slot per fixture. The sidecar key invalidates it when emitted
    # C, runtime support, compiler flags, or platform changes; old revisions do
    # not accumulate another full corpus of native binaries.
    cached="$TSAOT_SELFCONF_CACHE_DIR/$slug.bin"
    cached_key="$TSAOT_SELFCONF_CACHE_DIR/$slug.key"
    cache_state="miss"
  fi

  if [[ -n "$cached" && -x "$cached" && -f "$cached_key" &&
        "$(head -1 "$cached_key")" == "$cache_key" ]]; then
    # Usually build/ and mktemp live on the same filesystem. A hard link avoids
    # copying hundreds of ~500 KiB binaries on every warm conformance run.
    ln "$cached" "$bin" 2>/dev/null || cp "$cached" "$bin"
    cache_state="hit"
  else
    # shellcheck disable=SC2086
    if ! $CC "$cfile" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS \
        -I"$ROOT/runtime" -lm $TSAOT_FETCH_LDLIBS ${TSAOT_LDLIBS:-} \
        -o "$bin" 2>"$TSAOT_SELFCONF_TMP/results/$slug.cc.err"; then
      local first
      first=$(grep -m1 error "$TSAOT_SELFCONF_TMP/results/$slug.cc.err" || head -1 "$TSAOT_SELFCONF_TMP/results/$slug.cc.err")
      printf 'CCFAIL\t%s\t%s\n' "$name" "$first" > "$result"
      return
    fi
    if [[ -n "$cached" ]]; then
      local cache_tmp="$cached.$$"
      local key_tmp="$cached_key.$$"
      if cp "$bin" "$cache_tmp"; then
        chmod +x "$cache_tmp"
        mv "$cache_tmp" "$cached"
        printf '%s\n' "$cache_key" > "$key_tmp"
        mv "$key_tmp" "$cached_key"
      fi
    fi
  fi

  local oracle got
  oracle=$(perl -e 'alarm 20; exec @ARGV' node "$jsref" 2>&1)
  got=$(perl -e 'alarm 20; exec @ARGV' "$bin" 2>&1)
  if [[ "$got" == "$oracle" ]]; then
    printf 'PASS\t%s\t%s\n' "$name" "$cache_state" > "$result"
  elif [[ "$is_known" == "1" ]]; then
    printf 'KNOWN\t%s\t%s\n' "$name" "$cache_state" > "$result"
  else
    printf 'DIFF\t%s\t%s\n' "$name" "$cache_state" > "$result"
  fi
}

export -f run_selfconf_case
export -f selfconf_sha256
export ROOT CC TSAOT_LDLIBS TSAOT_SELFCONF_TMP="$tmp"
export TSAOT_SELFCONF_CACHE="$SELFCONF_CACHE"
export TSAOT_SELFCONF_CACHE_DIR="$SELFCONF_CACHE_DIR"
export TSAOT_SELFCONF_SUPPORT_KEY="$SELFCONF_SUPPORT_KEY"

t2=$(now_ms)
if [[ -s "$tmp/run.list.tsv" ]]; then
  while IFS=$'\t' read -r slug path name is_known; do
    printf '%s\0%s\0%s\0%s\0' "$slug" "$path" "$name" "$is_known"
  done < "$tmp/run.list.tsv" |
    xargs -0 -n 4 -P "$jobs" bash -c 'run_selfconf_case "$1" "$2" "$3" "$4"' _
fi
t3=$(now_ms)
echo "[selfconf] native+oracle workers=$jobs $((t3-t2))ms"

while IFS=$'\t' read -r slug _path name _known; do
  result="$tmp/results/$slug.status"
  if [[ ! -f "$result" ]]; then
    ccfail=$((ccfail+1))
    echo "$name: worker produced no result" >> "$tmp/ccfail.txt"
    continue
  fi
  IFS=$'\t' read -r kind rname detail < "$result"
  case "$detail" in
    hit) cache_hit=$((cache_hit+1));;
    miss) cache_miss=$((cache_miss+1));;
    off) cache_off=$((cache_off+1));;
  esac
  case "$kind" in
    PASS) pass=$((pass+1));;
    KNOWN) known=$((known+1)); echo "$rname" >> "$tmp/known.txt";;
    DIFF) diff=$((diff+1)); echo "$rname" >> "$tmp/diff.txt";;
    CCFAIL) ccfail=$((ccfail+1)); echo "$rname: $detail" >> "$tmp/ccfail.txt";;
    *) ccfail=$((ccfail+1)); echo "$name: invalid worker result" >> "$tmp/ccfail.txt";;
  esac
done < "$tmp/run.list.tsv"

echo "[selfconf] native cache hit=$cache_hit miss=$cache_miss off=$cache_off"
echo "==================== analyzer_ts conformance ===================="
echo "total=$total  PASS=$pass  UNPORTED=$unported  CCFAIL=$ccfail  DIFF=$diff  KNOWN=$known  EXPORTER-skip=$expfail"
echo
echo "--- top UNPORTED reasons (Phase 1 work-list) ---"
sort "$tmp/unported.txt" | uniq -c | sort -rn | head -30
if [[ -s "$tmp/ccfail.txt" ]]; then echo; echo "--- CCFAIL (porting bugs, first 15) ---"; head -15 "$tmp/ccfail.txt"; fi
if [[ -s "$tmp/diff.txt" ]]; then echo; echo "--- DIFF (output mismatch, first 15) ---"; head -15 "$tmp/diff.txt"; fi
if [[ -s "$tmp/known.txt" ]]; then echo; echo "--- KNOWN frozen diffs (allowlist: scripts/frozen_known_diffs.tsv) ---"; cat "$tmp/known.txt"; fi
