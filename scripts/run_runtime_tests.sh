#!/usr/bin/env bash
# Build and run the ts_rt runtime unit tests.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
bash "$ROOT/tests/runtime_inline_policy_gate.sh"
bash "$ROOT/tests/header_bytes_gate.sh"
bash "$ROOT/tests/propmap_access_gate.sh"
cd "$ROOT/runtime"
echo "[runtime] compiling ts_rt + tests"
$CC ts_rt_test.c ts_rt.c -DTSAOT_ENABLE_FETCH=1 -lm -lcurl $TSAOT_LDLIBS -o /tmp/tsaot_rt_test
echo "[runtime] running"
/tmp/tsaot_rt_test
echo "[runtime] stack check (docs/stack_check_design.md)"
$CC -DTSAOT_STACK_CHECK ts_sc_test.c ts_rt.c -DTSAOT_ENABLE_FETCH=1 -lm -lcurl $TSAOT_LDLIBS -o /tmp/tsaot_sc_test
/tmp/tsaot_sc_test
