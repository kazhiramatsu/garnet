#!/usr/bin/env bash
# Math's transcendental functions (runtime/ts_ieee754.c) against Node's, bit for bit: the C
# harness and the node harness hash the same 100,000 inputs per range per function and print
# the edge cases; the outputs must be identical. The port is compiled with the toolchain's
# default flags on purpose (no -ffp-contract: Node's V8 is built with the default too, and
# the last bit of a few results depends on it; see the header of ts_ieee754.c).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CC="${TSAOT_CC:-cc -O2}"
work="$ROOT/build/math_v8_parity"
mkdir -p "$work"
$CC -std=c11 -I"$ROOT/runtime" -o "$work/harness" "$ROOT/tests/math_v8_parity/harness.c" -lm || { echo "[math-parity] FAIL: harness build"; exit 1; }
"$work/harness" > "$work/c.txt" || { echo "[math-parity] FAIL: harness run"; exit 1; }
node "$ROOT/tests/math_v8_parity/harness.mjs" > "$work/node.txt" || { echo "[math-parity] FAIL: node harness"; exit 1; }
total=$(wc -l < "$work/c.txt" | tr -d ' ')
bad=$(diff "$work/c.txt" "$work/node.txt" | grep -c '^<')
if [ "$bad" -eq 0 ] && [ "$total" -gt 0 ]; then
  echo "[math-parity] PASS ($total lines identical: 21 functions, 6 ranges x 100000 inputs, edge cases)"
else
  echo "[math-parity] FAIL: $bad of $total lines differ"
  diff "$work/c.txt" "$work/node.txt" | grep '^[<>]' | head -20
  exit 1
fi
