#!/usr/bin/env bash
# Run analyzer unit-test suites inside the cargo crate (so serde is available).
# Each tests/*_tests.rs is a standalone `main` with `mod escape_ir;` etc. We copy
# it to src/bin/<name>.rs and rewrite its `mod X;` lines to `#[path="../X.rs"] mod X;`
# so they resolve to the canonical src/ modules (or temp-copied extras).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/analyzer"; SRC="$CRATE/src"; TST="$ROOT/tests"; BIN="$SRC/bin"
fail=0
# Per-test list of EXTRA modules to materialize under analyzer/src/ before the
# test compiles. (`declare -A` is bash 4+ only; macOS ships bash 3.2 — use a
# function with a case for portability.)
extras_for() {
  case "$1" in
    escape_analysis_p1_tests|call_graph_p2_tests|interproc_p3_tests) echo "escape_analysis" ;;
    classes_tests) echo "classes" ;;
    *) echo "" ;;
  esac
}
mkdir -p "$BIN"
cleanup(){ rm -rf "$BIN"; for m in escape_analysis classes; do rm -f "$SRC/$m.rs"; done; }
trap cleanup EXIT

rewrite_mods() { # rewrite `mod X;` and `mod A; mod B;` to #[path="../X.rs"] form
  # NOTE: BSD sed (macOS) does NOT support the `\b` word-boundary escape — a
  # pattern using it silently never matches, leaving `mod X;` unrewritten so the
  # test bin looks for src/bin/X.rs (E0583). Anchor on start-of-line/whitespace
  # instead, which is portable across GNU and BSD sed.
  sed -E 's@(^|[[:space:]])mod ([a-z_]+);@\1#[path="../\2.rs"] mod \2;@g' "$1"
}

for test in escape_analysis_p1_tests call_graph_p2_tests interproc_p3_tests \
            interproc_closure_tests codegen_tests classes_tests devirt_tests c_units_tests; do
  [[ -f "$TST/$test.rs" ]] || { echo "[unit] SKIP $test"; continue; }
  for m in $(extras_for "$test"); do cp "$TST/$m.rs" "$SRC/$m.rs"; done
  rewrite_mods "$TST/$test.rs" > "$BIN/$test.rs"
  if out="$(cd "$CRATE" && cargo run --quiet --bin "$test" 2>&1)"; then
    echo "[unit] PASS $test"
  else
    echo "[unit] FAIL $test"; echo "$out" | tail -10; fail=1
  fi
  rm -f "$BIN/$test.rs"
  for m in $(extras_for "$test"); do rm -f "$SRC/$m.rs"; done
done
[[ $fail -ne 0 ]] && { echo "[unit] FAILURES"; exit 1; }
echo "[unit] all unit-test suites passed"
