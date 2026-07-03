#!/bin/bash
# Self-host regression gate — the ONE command for analyzer_ts development.
# (Development happens on the self-hosted TS analyzer since session 303; the
# frozen Rust analyzer is the differential oracle.)
#
# Stages (each prints PASS/FAIL; script exits non-zero on the first FAIL):
#   build      tsc analyzer_ts
#   conf       analyzer_ts conformance (TS emit vs node oracle, 327 fixtures)
#   smoke      analyzer_difftest.sh   (TS vs Rust vs node, 3-way)
#   devirt     devirt-pass dump diff  (TS vs Rust, all fixtures)
#   escape     escape-pass dump diff  (TS vs Rust, all fixtures)
#   native     garnet-compile selfhost.ts + selfhost_escape.ts
#   diffall    native emit vs node emit (byte-identical, all fixtures)
#   nescape    native escape vs Rust escape (byte-identical, all fixtures)
#   fixpoint   gen2 == gen3 (the self-hosted binary reproduces itself)
#
# Usage: scripts/selfhost_gate.sh [quick|typed]
#   quick = build + conf + smoke only (inner-loop edit cycle)
#   typed = delegate to scripts/typed_selfhost.sh (typed pipeline compiles
#           itself: parity + diffall + gen3 fixpoint; slow — native runs)
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUST="$ROOT/analyzer/target/release/tsaot"
MODE="${1:-full}"
if [ "$MODE" = "typed" ]; then
  exec bash "$(dirname "$0")/typed_selfhost.sh"
fi
work="${TMPDIR:-/tmp}/selfhost_gate"
mkdir -p "$work"

fail() { echo "[gate] FAIL: $1"; exit 1; }
ok() { echo "[gate] ok: $1"; }

# ---- build ----
(cd analyzer_ts && ./node_modules/.bin/tsc -p tsconfig.json) || fail "tsc analyzer_ts"
ok "build"

# ---- conformance ----
conf_out=$(bash scripts/analyzer_conformance.sh 2>&1 | grep "total=")
echo "[gate] $conf_out"
case "$conf_out" in
  *"CCFAIL=0"*) ;; *) fail "conformance CCFAIL" ;;
esac
case "$conf_out" in
  *"DIFF=0"*) ;; *) fail "conformance DIFF" ;;
esac
case "$conf_out" in
  *"UNPORTED=0"*) ;; *) fail "conformance UNPORTED" ;;
esac
ok "conf"

# ---- smoke (3-way) ----
bash scripts/analyzer_difftest.sh 2>&1 | tail -1 | grep -q "FAIL=0" || fail "smoke difftest"
ok "smoke"

if [ "$MODE" = "quick" ]; then
  echo "[gate] QUICK PASS (build+conf+smoke)"
  exit 0
fi

[ -x "$RUST" ] || fail "Rust oracle not built ($RUST)"

# ---- per-pass dump diffs over the whole corpus ----
pass_diff() { # $1 = mode name (devirt|escape)
  local mode="$1" same=0 diff_=0
  for ts in $(find tests/conformance/exhaustive -name "*.ts" | sort); do
    TSAOT_UNTYPED=1 node exporter/exporter.js "$ts" "$work/g.ir.json" "$work/g.l.json" >/dev/null 2>&1 || continue
    "$RUST" "$work/g.ir.json" "$mode" > "$work/g_rust.out" 2>/dev/null || continue
    node analyzer_ts/dist/main.js "$work/g.ir.json" "$mode" > "$work/g_ts.out" 2>/dev/null || { echo "  TSFAIL: $ts"; diff_=$((diff_+1)); continue; }
    if [ "$mode" = "devirt" ]; then
      node scripts/_devirt_diff.cjs "$work/g_rust.out" "$work/g_ts.out" >/dev/null || { echo "  DIFF: $ts"; diff_=$((diff_+1)); continue; }
    else
      cmp -s "$work/g_rust.out" "$work/g_ts.out" || { echo "  DIFF: $ts"; diff_=$((diff_+1)); continue; }
    fi
    same=$((same+1))
  done
  echo "[gate] $mode: identical=$same diff=$diff_"
  [ "$diff_" -eq 0 ]
}
pass_diff devirt || fail "devirt dump diff"
ok "devirt"
pass_diff escape || fail "escape dump diff"
ok "escape"

# ---- native build ----
TSAOT_ANALYZER=rust TSAOT_UNTYPED=1 ./garnet -o "$work/tsan_native.c" analyzer_ts/src/selfhost.ts >/dev/null 2>&1 || fail "garnet-compile selfhost.ts"
TSAOT_ANALYZER=rust TSAOT_UNTYPED=1 ./garnet -o "$work/tsan_escape.c" analyzer_ts/src/selfhost_escape.ts >/dev/null 2>&1 || fail "garnet-compile selfhost_escape.ts"
ok "native build"

# ---- diffall: native emit vs node emit (modulo console.log trailing newline) ----
same=0; diff_=0
for ts in $(find tests/conformance/exhaustive -name "*.ts" | sort); do
  TSAOT_UNTYPED=1 node exporter/exporter.js "$ts" "$work/d.ir.json" "$work/d.l.json" >/dev/null 2>&1 || continue
  node analyzer_ts/dist/main.js "$work/d.ir.json" emit > "$work/d_node.c" 2>/dev/null
  "$work/tsan_native" < "$work/d.ir.json" > "$work/d_native.c" 2>/dev/null || { echo "  NATIVEFAIL: $ts"; diff_=$((diff_+1)); continue; }
  printf '%s' "$(cat "$work/d_native.c")" > "$work/d_native_t.c"
  printf '%s' "$(cat "$work/d_node.c")" > "$work/d_node_t.c"
  if cmp -s "$work/d_node_t.c" "$work/d_native_t.c"; then same=$((same+1)); else
    diff_=$((diff_+1)); echo "  MISMATCH: $ts"; fi
done
echo "[gate] diffall: identical=$same mismatch=$diff_"
[ "$diff_" -eq 0 ] || fail "diffall"
ok "diffall"

# ---- native escape vs Rust escape ----
same=0; diff_=0
for ts in $(find tests/conformance/exhaustive -name "*.ts" | sort); do
  TSAOT_UNTYPED=1 node exporter/exporter.js "$ts" "$work/n.ir.json" "$work/n.l.json" >/dev/null 2>&1 || continue
  "$RUST" "$work/n.ir.json" escape > "$work/n_rust.json" 2>/dev/null || continue
  "$work/tsan_escape" < "$work/n.ir.json" > "$work/n_native.json" 2>/dev/null || { echo "  NATIVEFAIL: $ts"; diff_=$((diff_+1)); continue; }
  if cmp -s "$work/n_rust.json" "$work/n_native.json"; then same=$((same+1)); else
    diff_=$((diff_+1)); echo "  MISMATCH: $ts"; fi
done
echo "[gate] native-escape: identical=$same mismatch=$diff_"
[ "$diff_" -eq 0 ] || fail "native escape"
ok "nescape"

# ---- fixpoint: the self-hosted binary reproduces itself byte-identically ----
TSAOT_UNTYPED=1 node exporter/exporter.js analyzer_ts/src/selfhost.ts "$work/self.ir.json" "$work/self.l.json" >/dev/null 2>&1 || fail "export selfhost.ts"
"$work/tsan_native" < "$work/self.ir.json" > "$work/gen2.c" || fail "gen2 emit"
node analyzer_ts/dist/main.js "$work/self.ir.json" emit > "$work/gen2_node.c" || fail "gen2 node emit"
printf '%s' "$(cat "$work/gen2.c")" > "$work/gen2_t.c"
printf '%s' "$(cat "$work/gen2_node.c")" > "$work/gen2n_t.c"
cmp -s "$work/gen2_t.c" "$work/gen2n_t.c" || fail "gen2 native != node"
export ROOT CC="${TSAOT_CC:-cc -O2}"
. scripts/mimalloc_flags.sh 2>/dev/null || true
. scripts/regexp_link_flags.sh || fail "regexp link flags"
[ -f "$work/rt.o" ] || cc -O2 -c runtime/ts_rt.c -Iruntime -o "$work/rt.o" || fail "runtime build"
tsaot_prepare_regexp_objs "$work/gen2.c" "$work" >/dev/null 2>&1
tsaot_prepare_unicode_objs "$work/gen2.c" "$work" >/dev/null 2>&1
tsaot_prepare_fetch_runtime "$work/gen2.c" "$work" "$work/rt.o" >/dev/null 2>&1
# shellcheck disable=SC2086
cc -O2 "$work/gen2.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS \
  -Iruntime -lm $TSAOT_FETCH_LDLIBS ${TSAOT_LDLIBS:-} -o "$work/tsan_native2" 2>"$work/gen2cc.err" || fail "gen2 cc"
"$work/tsan_native2" < "$work/self.ir.json" > "$work/gen3.c" || fail "gen3 emit"
cmp -s "$work/gen2.c" "$work/gen3.c" || fail "fixpoint gen2 != gen3"
ok "fixpoint"

echo "[gate] FULL PASS"
