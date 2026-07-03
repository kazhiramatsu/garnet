#!/usr/bin/env bash
# Build and run the ts_rt runtime unit tests.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
cd "$ROOT/runtime"
echo "[runtime] compiling ts_rt + tests"
$CC ts_rt_test.c ts_rt.c -DTSAOT_ENABLE_FETCH=1 -lm -lcurl $TSAOT_LDLIBS -o /tmp/tsaot_rt_test
echo "[runtime] running"
/tmp/tsaot_rt_test
