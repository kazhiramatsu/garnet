#!/usr/bin/env bash
# tsaot CI bench (full): runs all benchmark shards. In time-limited environments
# run the shards individually instead:
#   scripts/ci_bench_correct1.sh   (stdlib/syntax/class/generics correctness)
#   scripts/ci_bench_correct2.sh   (async/generator/iterator correctness)
#   scripts/ci_bench_perf.sh       (timed performance kernels)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rc=0
bash "$ROOT/scripts/ci_bench_correct1.sh" || rc=1
bash "$ROOT/scripts/ci_bench_correct2.sh" || rc=1
bash "$ROOT/scripts/ci_bench_perf.sh" || rc=1
[[ $rc -eq 0 ]] && echo " CI-BENCH (all shards) PASSED" || echo " CI-BENCH FAILED"
exit $rc
