#!/usr/bin/env bash
# Focused moving-GC stress gate.
#
# This is intentionally narrower than full conformance: it codifies the cases
# that have exposed moving-minor raw-local / escape-boundary bugs, and runs them
# with TSAOT_GC_YOUNG_THRESHOLD=1. A normal O2 pass catches optimizer/layout
# sensitive failures; an ASan O0 pass catches memory lifetime issues.
#
# The script itself is deliberately serial. CI must run it as an isolated phase:
# threshold=1 turns nearly every allocation into a collection, so competing with
# unrelated compiler/benchmark jobs burns CPU without increasing GC coverage.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/scripts"
THRESHOLD="${TSAOT_GC_YOUNG_THRESHOLD:-1}"
ASAN_CC="${TSAOT_GC_STRESS_ASAN_CC:-gcc -O0 -g -fsanitize=address}"
RUN_ASAN="${TSAOT_GC_STRESS_ASAN:-1}"
RUN_RUNTIME_ASAN="${TSAOT_GC_STRESS_RUNTIME_ASAN:-1}"
RUN_PROTECT="${TSAOT_GC_STRESS_PROTECT:-1}"
RUN_BASE="${TSAOT_GC_STRESS_BASE:-1}"
RUN_FULL="${TSAOT_GC_STRESS_FULL:-0}"
RUN_STRING_SCALE="${TSAOT_GC_STRESS_STRING_SCALE:-1}"

FILTER='frame_roots_(unwind|edge_cases)|object_reflection_safepoints|string_runtime_safepoints|concat_growth|handle_identity|moving_minor_promise_coro_stress|json_runtime_safepoints|lower_level_runtime_safepoints|promise_coro_handle_edges|promise_movable_experimental|coro_entry_safepoints|coro_movable_experimental|array_callback_safepoints|generational_remembered_set|map_set_callback_safepoints|moving_minor_relocation|prototype_handle_edges|typed_class_allocation_safepoints|computed_member_names|extends_same_name_scopes|lazy_frame_getter|lazy_homes_reload|absent_site_entries|absent_site_records|function_own_properties|proxy_prototypes|reflect_receiver|array_iterators|forof_dynamic|dynamic_keys|string_accumulators|replace_builder|strict_eq_literals|payload_envs|payload_arrays|payload_props|payload_maps|coro_int_locals|proxy_old_generation|frame_elision|lazy_frame_calls|typed_array_buffers|typed_array_methods|typed_array_reflection|typed_array_elements|element_receivers|atomics|text_codecs'

rc=0
echo "=== tsaot GC stress [young threshold=$THRESHOLD] ==="

if [[ "$RUN_BASE" != "0" ]]; then
  echo ">>> focused conformance (normal O2)"
  TSAOT_GC_YOUNG_THRESHOLD="$THRESHOLD" \
    bash "$S/run_conformance.sh" exhaustive "$FILTER" || rc=1

  if [[ "$RUN_ASAN" != "0" ]]; then
    echo ">>> focused conformance (ASan)"
    TSAOT_GC_YOUNG_THRESHOLD="$THRESHOLD" TSAOT_CC="$ASAN_CC" \
      bash "$S/run_conformance.sh" exhaustive "$FILTER" || rc=1
  fi

  if [[ "$RUN_RUNTIME_ASAN" != "0" ]]; then
    echo ">>> runtime unit tests (ASan)"
    TSAOT_GC_YOUNG_THRESHOLD="$THRESHOLD" TSAOT_CC="$ASAN_CC" \
      bash "$S/run_runtime_tests.sh" || rc=1
  fi
fi

if [[ "$RUN_PROTECT" != "0" ]]; then
  # Protect mode (docs/gc_v2_design.md §6.8): freed cells are zapped and
  # quarantined instead of reused, and a collection that reaches one reports
  # the dangling reference (a missing root or write barrier).
  echo ">>> focused conformance (protect mode, normal O2)"
  TSAOT_GC_YOUNG_THRESHOLD="$THRESHOLD" TSAOT_GC_PROTECT=1 \
    bash "$S/run_conformance.sh" exhaustive "$FILTER" || rc=1
  echo ">>> runtime unit tests (protect mode)"
  TSAOT_GC_YOUNG_THRESHOLD="$THRESHOLD" TSAOT_GC_PROTECT=1 \
    bash "$S/run_runtime_tests.sh" || rc=1
fi

# The aging gates retired with the copying nursery: the non-moving heap
# promotes in place at the first survival (docs/gc_v2_design.md §6.8).

if [[ "$RUN_FULL" == "1" ]]; then
  echo ">>> full exhaustive conformance (normal O2)"
  TSAOT_GC_YOUNG_THRESHOLD="$THRESHOLD" \
    bash "$S/run_conformance.sh" exhaustive || rc=1
fi

if [[ "$RUN_STRING_SCALE" != "0" ]]; then
  if [[ "$RUN_ASAN" != "0" ]]; then
    echo ">>> string-builder 64 MiB scale stress (O2 + ASan)"
  else
    echo ">>> string-builder 64 MiB scale stress (O2)"
  fi
  TSAOT_STRING_SCALE_ASAN="$RUN_ASAN" \
    bash "$ROOT/tests/string_builder_scale_gate.sh" || rc=1
fi

if [[ $rc -eq 0 ]]; then
  echo " GC-STRESS PASSED"
else
  echo " GC-STRESS FAILED"
fi
exit $rc
