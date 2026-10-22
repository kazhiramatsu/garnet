#!/usr/bin/env bash
# The cell header's flags byte and sized class instances' extents
# (docs/cell_header_design.md) under every knob that changes how instances are
# made, shaped or rescanned: the class index, the property caches, header-only
# instances as plain or unsized cells, whole-cell rescans of remembered plain
# objects, stack-check copies of stack instances, and collections forced by
# protect mode, zap mode and the full-collection threshold. V8 is the oracle
# (run_conformance.sh); every run must match it.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/scripts"
CC_BASE="${TSAOT_CC:-gcc -O2}"
# Fixtures with small live sets (a forced full-collection threshold collects
# at every allocation once the live set passes it). Without the class index a
# sized instance relinked behind another class's prototype takes that class's
# layout (only the class index word remembers its allocation class; a known
# limitation of the TSAOT_CLASS_INDEX=0 mode, which production does not use),
# so the relinks fixture runs with the index on only.
CORE='sized_header_(layouts|big_record|stack_props)|sized_sidecar_props|string_slack_growth|remembered_slots|unsized_with_class_proto'
SMALL="$CORE|sized_header_relinks"
ALL="$SMALL|site_pretenured_classes"
NOINDEX="$CORE|site_pretenured_classes"
rc=0
run() { # label filter env...
  local label="$1" filter="$2"; shift 2
  echo ">>> $label"
  env "$@" bash "$S/run_conformance.sh" exhaustive "$filter" || rc=1
}
run "default" "$ALL"
run "class index off" "$NOINDEX" TSAOT_CLASS_INDEX=0
run "property caches off" "$ALL" TSAOT_PROP_PIC=0
run "header-only instances as unsized cells" "$ALL" TSAOT_EMPTY_CLASS_PLAIN=0
run "class index off, header-only instances as unsized cells" "$NOINDEX" TSAOT_CLASS_INDEX=0 TSAOT_EMPTY_CLASS_PLAIN=0
run "whole-cell rescans of remembered plain objects" "$ALL" TSAOT_REMEMBERED_SLOTS=0
run "stack check" "$ALL" TSAOT_STACK_CHECK=1 TSAOT_CC="$CC_BASE -DTSAOT_STACK_CHECK"
run "protect mode, a minor collection every 64 allocations" "$ALL" TSAOT_GC_PROTECT=64 TSAOT_GC_YOUNG_THRESHOLD=64
run "zap mode, a minor collection every 16 allocations" "$ALL" TSAOT_GC_ZAP=1 TSAOT_GC_YOUNG_THRESHOLD=16
run "a full collection every 16 MiB" "$SMALL" TSAOT_GC_FULL_THRESHOLD_BYTES=16777216
if [[ $rc -eq 0 ]]; then echo "[cell-header] PASS"; else echo "[cell-header] FAIL"; fi
exit $rc
