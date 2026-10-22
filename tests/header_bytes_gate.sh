#!/usr/bin/env bash
# The cell header's inline_cap and hdr_spare bytes mean in-object slots and a
# remembered card range for a plain object, and the struct extent for a sized
# class instance (docs/cell_header_design.md). Only the helpers that know which
# reading applies may assign them; any other assignment in the runtime, or one
# in the emitters' C templates, fails here. Whole-header copies, initializers,
# memsets and aliasing pointers are outside what this sees: they are audited in
# the design document.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

helpers="gc_cards_all gc_cards_reset gc_cards_merge gc_hdr_init_plain gc_hdr_unsize ts_hdr_init_sized"
assign='(hdr_spare|inline_cap)[[:space:]]*([-+*/|&^]|<<|>>)?=([^=]|$)'

fail=0
# C: the enclosing function is the last line opening a definition at column 0.
if ! awk -v helpers="$helpers" -v pat="$assign" '
  BEGIN { n = split(helpers, a, " "); for (i = 1; i <= n; i++) ok[a[i]] = 1 }
  FNR == 1 { fn = "" }
  /^[A-Za-z_][^;]*\(/ && !/^(typedef|enum|struct|union)/ {
    name = $0; sub(/\(.*/, "", name); sub(/.*[^A-Za-z0-9_]/, "", name); fn = name
  }
  $0 ~ pat && !(fn in ok) {
    printf "[header-bytes] FAIL: %s:%d assigns a header extent byte outside the helpers (in %s): %s\n", FILENAME, FNR, fn, $0
    bad = 1
  }
  END { exit bad }
' "$ROOT"/runtime/*.c "$ROOT"/runtime/*.h; then
  fail=1
fi
# The emitters write a sized instance's header through ts_hdr_init_sized only.
if grep -nE "$assign" "$ROOT/analyzer/src/emit_c.rs" "$ROOT/analyzer_ts/src/emitc.ts" "$ROOT/analyzer_ts/src/emit.ts"; then
  echo "[header-bytes] FAIL: an emitter assigns a header extent byte (use ts_hdr_init_sized)"
  fail=1
fi
[ "$fail" = 0 ] || exit 1
echo "[header-bytes] PASS: inline_cap and hdr_spare are assigned only by the header helpers"
