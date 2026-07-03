#!/bin/bash
# Typed self-host gate: the TYPED pipeline (devirt -> escape -> sroa -> emitc)
# compiles ITSELF (no TSAOT_UNTYPED) and reproduces its own C byte-identically.
#
# Stages:
#   export     exporter on selfhost_typed.ts (typed IR, zero type errors)
#   parity     Rust `tsaot <ir> emit`  ==  node `main.js <ir> emitc`  (byte)
#   build      garnet (typed) compiles selfhost_typed.ts -> native binary
#   diffall    native emitc == node emitc on all conformance fixtures (typed)
#   fixpoint   gen1 (Rust emit) == gen2 (native emitc on own IR) == gen3
#
# The native binary needs a large C stack: the analyzer's own IR nests its big
# switch lowerings ~300 deep, and emitc frames are wide. Run under `ulimit -s`.
set -u
cd "$(dirname "$0")/.."
RUST=analyzer/target/release/tsaot
W="${TMPDIR:-/tmp}/typed_selfhost"
mkdir -p "$W"
STACK_KB=65520

fail() { echo "[typed-gate] FAIL: $1"; exit 1; }
ok() { echo "[typed-gate] ok: $1"; }

(cd analyzer_ts && ./node_modules/.bin/tsc -p tsconfig.json) || fail "tsc analyzer_ts"
ok "tsc"

# ---- export (typed) ----
node exporter/exporter.js analyzer_ts/src/selfhost_typed.ts "$W/self.ir.json" "$W/self.l.json" >/dev/null 2>&1 \
  || fail "typed export of selfhost_typed.ts"
ok "export"

# ---- node parity on own IR ----
"$RUST" "$W/self.ir.json" emit > "$W/gen1.c" 2>/dev/null || fail "Rust emit on own IR"
node analyzer_ts/dist/main.js "$W/self.ir.json" emitc > "$W/gen1_node.c" 2>/dev/null || fail "node emitc on own IR"
cmp -s "$W/gen1.c" "$W/gen1_node.c" || fail "Rust emit != node emitc on own IR"
ok "parity (rust == node on own IR)"

# ---- typed native build ----
TSAOT_ANALYZER=rust ./garnet -o "$W/tsan_typed.c" analyzer_ts/src/selfhost_typed.ts >/dev/null 2>&1 \
  || fail "garnet typed-compile selfhost_typed.ts"
ok "build"

# ---- diffall: native emitc vs node emitc over the conformance corpus ----
same=0; diff_=0
for ts in $(find tests/conformance/exhaustive -name "*.ts" | sort); do
  slug=$(echo "${ts#tests/conformance/exhaustive/}" | tr '/' '__'); slug="${slug%.ts}"
  prog="${TMPDIR:-/tmp}/emitc_diff/json/$slug.program.json"
  if [ ! -f "$prog" ]; then
    node exporter/exporter.js "$ts" "$W/d.ir.json" "$W/d.l.json" >/dev/null 2>&1 || continue
    prog="$W/d.ir.json"
  fi
  node analyzer_ts/dist/main.js "$prog" emitc > "$W/d_node.c" 2>/dev/null || continue
  (ulimit -s "$STACK_KB"; "$W/tsan_typed" < "$prog" > "$W/d_native.c" 2>/dev/null) \
    || { echo "  NATIVEFAIL: $ts"; diff_=$((diff_+1)); continue; }
  printf '%s' "$(cat "$W/d_native.c")" > "$W/d_native_t.c"
  printf '%s' "$(cat "$W/d_node.c")" > "$W/d_node_t.c"
  if cmp -s "$W/d_node_t.c" "$W/d_native_t.c"; then same=$((same+1)); else
    diff_=$((diff_+1)); echo "  MISMATCH: $ts"; fi
done
echo "[typed-gate] diffall: identical=$same mismatch=$diff_"
[ "$diff_" -eq 0 ] || fail "typed diffall"
ok "diffall"

# ---- fixpoint: gen2 (native on own IR) == gen1; gen3 (binary2) == gen2 ----
(ulimit -s "$STACK_KB"; "$W/tsan_typed" < "$W/self.ir.json" > "$W/gen2.c") || fail "gen2 emit"
printf '%s' "$(cat "$W/gen1.c")" > "$W/gen1_t.c"
printf '%s' "$(cat "$W/gen2.c")" > "$W/gen2_t.c"
cmp -s "$W/gen1_t.c" "$W/gen2_t.c" || fail "gen2 != gen1"
ok "gen2 == gen1"

# build binary2 from gen2 and emit gen3 (empirical closure; gen2==gen1 already
# implies it, but run the loop once for the record)
build_dir="$W/gen2_build"
mkdir -p "$build_dir"
cp "$W/gen2_t.c" "$build_dir/tsan_typed2.c"
# compile gen2 the same way the garnet driver does (runtime + optional objs)
ROOT="$(pwd)"
CC="${TSAOT_CC:-cc -O2}"
export ROOT CC
. "$ROOT/scripts/lib/mimalloc_flags.sh" || fail "mimalloc flags"
. "$ROOT/scripts/lib/regexp_link_flags.sh" || fail "regexp link flags"
RT_OBJ="$ROOT/build/rt.o"
mkdir -p "$ROOT/build"
if [ ! -f "$RT_OBJ" ] || [ "$ROOT/runtime/ts_rt.c" -nt "$RT_OBJ" ]; then
  $CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$RT_OBJ" || fail "build runtime"
fi
tsaot_prepare_regexp_objs "$build_dir/tsan_typed2.c" "$build_dir" || fail "regexp objs"
tsaot_prepare_unicode_objs "$build_dir/tsan_typed2.c" "$build_dir" || fail "unicode objs"
tsaot_prepare_fetch_runtime "$build_dir/tsan_typed2.c" "$build_dir" "$RT_OBJ" || fail "fetch runtime"
# shellcheck disable=SC2086
$CC "$build_dir/tsan_typed2.c" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS \
  -I"$ROOT/runtime" -lm $TSAOT_FETCH_LDLIBS ${TSAOT_LDLIBS:-} -o "$build_dir/tsan_typed2" \
  || fail "cc gen2"
(ulimit -s "$STACK_KB"; "$build_dir/tsan_typed2" < "$W/self.ir.json" > "$W/gen3.c") || fail "gen3 emit"
printf '%s' "$(cat "$W/gen3.c")" > "$W/gen3_t.c"
cmp -s "$W/gen2_t.c" "$W/gen3_t.c" || fail "gen3 != gen2"
ok "gen3 == gen2 (fixpoint)"

echo "[typed-gate] TYPED PASS"
