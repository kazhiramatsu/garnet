#!/bin/bash
# Pattern benchmarks against V8: compile each kernel with garnet through the
# differential harness (output must match Node), then time the native binary
# and Node (best of 3). Kernels live in benchmarks/patterns (one tsc-style
# pattern each, scaled to 100-200 ms under Node; Node times include ~60 ms of
# startup). Usage: scripts/pattern_bench.sh [kernel.ts ...]
# The kernels are compiled under the strict type profile (`--strict`), the
# configuration a tuned program is built with (README, "Turn on strict"):
# the class hints and the unboxed fields live there (class_enum_fields is 4.5x
# faster than in plain mode). PB_PLAIN=1 measures the plain profile instead.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
if [ "${PB_PLAIN:-0}" != "1" ]; then export DT_EXPORT_FLAGS="${DT_EXPORT_FLAGS:---strict}"; fi
source scripts/difftest.sh >/dev/null 2>&1
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
best_of() { local b=999999; for i in 1 2 3; do local t0=$(ms); "$@" >/dev/null 2>&1; local t1=$(ms); local d=$((t1-t0)); [ $d -lt $b ] && b=$d; done; echo $b; }
printf "%-22s %9s %8s %6s  %s\n" kernel native_ms node_ms ratio verdict
files=("$@"); [ $# -eq 0 ] && files=("$ROOT"/benchmarks/patterns/*.ts)
for f in "${files[@]}"; do
  n=$(basename "$f" .ts)
  v=$(dt "$n" "$(cat "$f")" 2>&1 | grep -oE "OK|DIFF|REJECT" | head -n1)
  if [ -x build/dt ] && [ -f build/dt.mjs ] && [ "$v" = "OK" ]; then
    # a kernel importing one of garnet's modules runs node with the scheme's loader (as dt does)
    nodeflags=""; grep -q "garnet:" build/dt.mjs && nodeflags="--import $ROOT/scripts/garnet_scheme_loader.mjs"
    tn=$(best_of ./build/dt); tv=$(best_of node $nodeflags build/dt.mjs)
    ratio=$(python3 -c "print(f'{$tn/max($tv,1):.2f}')")
    printf "%-22s %9s %8s %6s  %s\n" "$n" "$tn" "$tv" "$ratio" "$v"
  else
    printf "%-22s %9s %8s %6s  %s\n" "$n" - - - "${v:-BUILD_FAIL}"
  fi
done
