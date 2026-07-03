#!/usr/bin/env bash
# V8 reference runner for benchmark rows that provide a CommonJS JS reference:
#   module.exports = { kernel, BENCH_N }
#
# This measures kernel(BENCH_N) inside one Node/V8 process after a correctness
# warm-up, avoiding Node startup time for short microbenchmarks.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${TSAOT_MANIFEST:-$ROOT/benchmarks/manifest.tsv}"
FILTER="${1:-}"
RUNS="${TSAOT_RUNS:-5}"
fail=0

printf "%-26s %-12s %-12s %-11s %s\n" "BENCHMARK" "RESULT" "EXPECTED" "V8_MS" "STATUS"
printf -- "-------------------------------------------------------------------------------\n"

while IFS=$'\t' read -r name source expected budget v8ref verdict; do
  [[ "$name" =~ ^#.*$ || -z "$name" ]] && continue
  [[ -n "$FILTER" ]] && ! [[ "$name" =~ ${FILTER} ]] && continue
  js="$ROOT/benchmarks/${source%.ts}.js"
  if [[ ! -f "$js" ]]; then
    printf "%-26s %-12s %-12s %-11s %s\n" "$name" "-" "$expected" "-" "NO_JS_REF"
    fail=1
    continue
  fi
  result="$(node - "$js" "$expected" "$RUNS" <<'JS'
const modPath = process.argv[2];
const expected = process.argv[3];
const runs = Number(process.argv[4] || "5");
const bench = require(modPath);
if (typeof bench.kernel !== "function" || typeof bench.BENCH_N !== "number") {
  console.log("-\t-\tNO_EXPORT");
  process.exit(0);
}
const out = String(bench.kernel(bench.BENCH_N));
if (out !== expected) {
  console.log(`${out}\t-\tWRONG_OUTPUT`);
  process.exit(0);
}
let best = Infinity;
for (let r = 0; r < runs; r++) {
  const t0 = performance.now();
  const got = String(bench.kernel(bench.BENCH_N));
  const dt = performance.now() - t0;
  if (got !== expected) {
    console.log(`${got}\t-\tWRONG_OUTPUT`);
    process.exit(0);
  }
  if (dt < best) best = dt;
}
console.log(`${out}\t${Math.round(best)}\tPASS`);
JS
)"
  IFS=$'\t' read -r out ms status <<EOF
$result
EOF
  [[ "$status" == "PASS" ]] || fail=1
  printf "%-26s %-12s %-12s %-11s %s\n" "$name" "$out" "$expected" "$ms" "$status"
done < "$MANIFEST"

printf -- "-------------------------------------------------------------------------------\n"
if [[ $fail -ne 0 ]]; then
  echo "[v8] FAILURES detected"
  exit 1
fi
echo "[v8] all selected benchmarks matched expected output"
