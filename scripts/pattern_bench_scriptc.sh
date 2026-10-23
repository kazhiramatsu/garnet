#!/bin/bash
# Pattern kernels against scriptc: each kernel in benchmarks/patterns built by
# garnet (through the differential harness, so its output matches Node) and by
# scriptc (`SCRIPTC=<path to the scriptc executable>`, the tsc-ts checkout's
# node_modules/.bin/scriptc), then instructions retired, cycles and wall time
# of the two natives (the best of three) and their outputs compared. The
# instruction ratio is the lever: garnet's time against scriptc's is an
# instruction-count gap, not a memory one (docs/single_thread_vs_scriptc.md).
# Usage: SCRIPTC=... [STRICT=0] scripts/pattern_bench_scriptc.sh [kernel.ts ...]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
SCRIPTC="${SCRIPTC:?set SCRIPTC to the scriptc executable}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
source scripts/difftest.sh > /dev/null 2>&1
# the kernels are exported as a strict project is (tsc-ts's tsconfig is strict), unless STRICT=0
[ "${STRICT:-1}" = 0 ] || export DT_EXPORT_FLAGS="--strict"
measure() { # binary -> "instructions cycles wall", the run with the fewest cycles of three
  local bi=0 bc=0 bw=0 i
  for i in 1 2 3; do
    /usr/bin/time -l "$1" > /dev/null 2> "$WORK/run.err"
    local ins cyc w
    ins=$(awk '/instructions retired/ {print $1}' "$WORK/run.err"); cyc=$(awk '/cycles elapsed/ {print $1}' "$WORK/run.err"); w=$(awk '/real/ {print $1}' "$WORK/run.err")
    if [ "$bc" = 0 ] || [ "$cyc" -lt "$bc" ]; then bi=$ins; bc=$cyc; bw=$w; fi
  done
  echo "$bi $bc $bw"
}
printf "%-20s %9s %9s %6s %8s %8s %6s  %s\n" kernel garnet_Gi scriptc_Gi ratio g_ms s_ms ratio outputs
files=("$@"); [ $# -eq 0 ] && files=("$ROOT"/benchmarks/patterns/*.ts)
for f in "${files[@]}"; do
  f="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"   # absolute: the build runs in $WORK
  n=$(basename "$f" .ts)
  v=$(dt "$n" "$(cat "$f")" 2>&1 | grep -oE "OK|DIFF|REJECT" | head -n1)
  [ "$v" = "OK" ] || { printf "%-20s garnet: %s\n" "$n" "${v:-BUILD_FAIL}"; continue; }
  cp build/dt "$WORK/$n.g"
  if ! ( cd "$WORK" && cp "$f" "$n.ts" && "$SCRIPTC" build "$n.ts" --optimization=speed -o "$n.s" > "$n.log" 2>&1 ); then
    printf "%-20s scriptc rejects it: %s\n" "$n" "$(grep -oE 'error SC[0-9]+: .{0,70}' "$WORK/$n.log" | head -1)"; continue
  fi
  go=$("$WORK/$n.g" 2>&1 | shasum | cut -c1-8); so=$("$WORK/$n.s" 2>&1 | shasum | cut -c1-8)
  read -r gi gc gw <<< "$(measure "$WORK/$n.g")"; read -r si sc sw <<< "$(measure "$WORK/$n.s")"
  python3 - "$n" "$gi" "$si" "$gw" "$sw" "$([ "$go" = "$so" ] && echo same || echo DIFFER)" <<'PY'
import sys
n, gi, si, gw, sw, same = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), sys.argv[6]
print(f"{n:20s} {gi/1e9:9.2f} {si/1e9:9.2f} {gi/max(si,1):6.2f} {gw*1000:8.0f} {sw*1000:8.0f} {gw/max(sw,1e-9):6.2f}  {same}")
PY
done
