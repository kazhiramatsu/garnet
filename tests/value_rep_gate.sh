#!/usr/bin/env bash
# The value representation's source gate (docs/unmasked_pointers_design.md). What reads a word's bits
# is defined between the markers `TS_VALUE_REP definitions: begin` and `: end` in runtime/ts_rt.h; code
# elsewhere goes through those definitions, so that a change of the representation (TS_VALUE_REP)
# changes what they say and nothing else has to. Outside the markers this fails on:
#   - the representation's constants: TS_SEL_SHIFT, TS_PAYLOAD_MASK, TS_PTR_STACK_TAG, TS_NUM_XOR, TS_SEL_BASE;
#   - a selector spelled as a number: TS_BOX(0x...;
#   - a shift by 47, 48, 51, 52 or 63 (a word's tag, selector, or a number's sign and exponent read off
#     the word), outside the functions below that shift integers that are no words;
#   - a 64-bit literal compared with something (a number's bits compared as a word), or given a name by
#     a macro (TS_MAPSET_NEG_ZERO was the word of -0 spelled as bits), outside the macros below.
# The emitters (the generated C), the frozen twin's templates and the native host must not name the
# constants or spell a selector either. Types are not seen: a word shifted under another name, or a
# double's bits taken with memcpy outside ts_num / ts_to_num, are the design's audit to keep.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# functions whose shifts are of integers that are no words: a BigInt's limbs, the shortest
# double-to-decimal conversion, the half-precision conversion
allowed_fns="big_from_twos dtoa_rop dtoa_shortest ts_double_to_f16_bits"

# macros of 64-bit constants that are no words: a double built from its bits, the stack check's magic
allowed_macros="TSM_NAN TS_SC_MAGIC"

names='TS_SEL_SHIFT|TS_PAYLOAD_MASK|TS_PTR_STACK_TAG|TS_NUM_XOR|TS_SEL_BASE'
fail=0
if ! awk -v allowed="$allowed_fns" -v macros="$allowed_macros" -v names="$names" '
  BEGIN { n = split(allowed, a, " "); for (i = 1; i <= n; i++) ok[a[i]] = 1
          n = split(macros, a, " "); for (i = 1; i <= n; i++) okm[a[i]] = 1 }
  FNR == 1 { fn = ""; inblock = 0 }
  /TS_VALUE_REP definitions: begin/ { inblock = 1; next }
  /TS_VALUE_REP definitions: end/ { inblock = 0; next }
  inblock { next }
  /^[A-Za-z_][^;]*\(/ && !/^(typedef|enum|struct|union|#)/ {
    name = $0; sub(/\(.*/, "", name); sub(/.*[^A-Za-z0-9_]/, "", name); fn = name
  }
  {
    line = $0
    sub(/\/\/.*/, "", line)
    why = ""
    if (line ~ ("(^|[^A-Za-z0-9_])(" names ")([^A-Za-z0-9_]|$)")) why = "names a constant of the representation"
    else if (line ~ /TS_BOX\(0[xX]/) why = "spells a selector as a number"
    else if (line ~ /(>>|<<)[[:space:]]*(47|48|51|52|63)([^0-9]|$)/ && !(fn in ok)) why = "shifts by a width of the representation"
    else if (line ~ /[!=]=[[:space:]]*\(?[[:space:]]*(\((uint64_t|tsv)\))?[[:space:]]*0[xX][0-9a-fA-F]{9,}/ || line ~ /0[xX][0-9a-fA-F]{9,}[uUlL]*[[:space:]]*\)?[[:space:]]*[!=]=/) why = "compares a 64-bit literal"
    else if (line ~ /^[[:space:]]*#[[:space:]]*define[[:space:]]+[A-Za-z_0-9]+/ && line ~ /0[xX][0-9a-fA-F]{9,}/) {
      m = line; sub(/^[[:space:]]*#[[:space:]]*define[[:space:]]+/, "", m); sub(/[^A-Za-z_0-9].*/, "", m)
      if (!(m in okm)) why = "names a 64-bit constant"
    }
    if (why != "") {
      printf "[value-rep] FAIL: %s:%d %s (in %s): %s\n", FILENAME, FNR, why, fn, $0
      bad = 1
    }
  }
  END { exit bad }
' "$ROOT"/runtime/*.c "$ROOT"/runtime/*.h "$ROOT"/runtime/regexp/*.c "$ROOT"/runtime/regexp/*.h; then
  fail=1
fi
# The emitters and the C beside them: the helpers only.
others=("$ROOT"/analyzer/src/*.rs "$ROOT"/analyzer_ts/templates/*.c "$ROOT"/benchmarks/typescript_native/host.c)
if grep -nE "(^|[^A-Za-z0-9_])($names)([^A-Za-z0-9_]|$)|TS_BOX\(0[xX]" "${others[@]}"; then
  echo "[value-rep] FAIL: an emitter or a host names the representation (use the helpers of ts_rt.h)"
  fail=1
fi
# The markers themselves: two blocks in ts_rt.h, each closed.
begins=$(grep -c 'TS_VALUE_REP definitions: begin' "$ROOT/runtime/ts_rt.h" || true)
ends=$(grep -c 'TS_VALUE_REP definitions: end' "$ROOT/runtime/ts_rt.h" || true)
if [ "$begins" != "$ends" ] || [ "$begins" -lt 1 ]; then
  echo "[value-rep] FAIL: the definitions' markers in runtime/ts_rt.h are unbalanced ($begins begin, $ends end)"
  fail=1
fi
[ "$fail" = 0 ] || exit 1
echo "[value-rep] PASS: words are read through the representation's definitions only ($begins blocks)"
