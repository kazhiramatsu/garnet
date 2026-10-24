#!/usr/bin/env bash
# Keep substantial runtime workers out of the public header. Generated C needs
# the declarations, but only bounded common-case guards should be replicated in
# each translation unit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
header="$ROOT/runtime/ts_rt.h"
source="$ROOT/runtime/ts_rt.c"

workers="
ts_str_view_typed_slow
ts_str_find_forward_view_slow
ts_str_find_backward_view_slow
ts_str_replace_literal_metric3
ts_str_split_join_metric3
ts_json_string_len_fast
"

for name in $workers; do
  grep -Eq "^[A-Za-z_][A-Za-z0-9_ *]*${name}\\(" "$header" || {
    echo "[runtime-inline] FAIL: $name has no header declaration"
    exit 1
  }
  grep -Eq "^[A-Za-z_][A-Za-z0-9_ *]*${name}\\(" "$source" || {
    echo "[runtime-inline] FAIL: $name has no out-of-line definition"
    exit 1
  }
  if grep -Eq "^(static inline|TS_RT_ALWAYS_INLINE).*${name}\\(" "$header"; then
    echo "[runtime-inline] FAIL: substantial worker $name moved back inline"
    exit 1
  fi
done

for name in \
  ts_str_view_typed \
  ts_str_find_forward_view \
  ts_str_find_backward_view
do
  grep -Eq "^static inline .*${name}\\(" "$header" || {
    echo "[runtime-inline] FAIL: bounded header fast path $name is missing"
    exit 1
  }
done

while IFS= read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    ts_prop_ic_probe_fixed_inline | \
    ts_prop_is_accessor_inline | \
    ts_get_pic_checked_inline | \
    ts_set_pic_inline | \
    ts_get_dyn_pic_checked_inline | \
    ts_set_dyn_pic_inline | \
    ts_get_pic_checked_inline_lazy | \
    ts_set_pic_inline_lazy | \
    ts_static_slot_probe | \
    ts_static_slot_probe2 | \
    ts_static_slot_probe3 | \
    ts_get_static3_inline | \
    ts_set_static3_inline | \
    ts_get_static3_inline_lazy | \
    ts_set_static3_inline_lazy | \
    ts_get_static_inline | \
    ts_get_static2_inline | \
    ts_set_static_inline | \
    ts_set_static2_inline | \
    ts_get_static_inline_lazy | \
    ts_get_static2_inline_lazy | \
    ts_set_static_inline_lazy | \
    ts_set_static2_inline_lazy | \
    ts_array_get_lazy | \
    ts_get_static_try | \
    ts_get_static2_try | \
    ts_get_static3_try | \
    ts_get_pic_try | \
    ts_set_static_try | \
    ts_set_static2_try | \
    ts_set_static3_try | \
    ts_set_pic_try | \
    ts_str_charcodeat_typed | \
    ts_strict_eq | \
    ts_eq_strlit | \
    ts_truthy_fast | \
    ts_to_int32 | \
    ts_to_uint32 | \
    ts_ta_elem_load | \
    ts_ta_elem_store | \
    ts_ta_elem_load_i32 | \
    ts_ta_try_load_i32 | \
    ts_ta_try_load_i | \
    ts_ta_try_load_f | \
    ts_ta_try_store_i | \
    ts_ta_try_store_f | \
    ts_ta_try_length | \
    sv0_hash_num_d | \
    sv0_hash_num | \
    ts_map_probe_num | \
    ts_map_get_num | \
    ts_array_push_inline | \
    ts_method_lookup_sized_ic | \
    ts_call_method_inline | \
    ts_store_frozen | \
    ts_prop_key_hash | \
    ts_class_word_cache_entry_for | \
    ts_class_word_cache_probe | \
    ts_prop_ic_probe_sized_inline | \
    ts_get_sized_pic_try | \
    ts_get_sized_pic_inline | \
    ts_get_sized_pic_inline_lazy | \
    ts_set_sized_pic_try | \
    ts_set_sized_pic_inline | \
    ts_set_sized_pic_inline_lazy | \
    ts_str_hash_fast | \
    ts_ref_hash | \
    ts_mapset_probe_inline | \
    ts_map_probe_str | \
    ts_map_probe_ref | \
    ts_map_get_str | \
    ts_map_has_str | \
    ts_map_get_ref | \
    ts_map_has_ref | \
    ts_set_probe_str | \
    ts_set_probe_ref | \
    ts_set_has_str | \
    ts_set_has_ref | \
    ts_eq_num | \
    ts_map_has_num) ;;
    *)
      echo "[runtime-inline] FAIL: unexpected always-inline runtime helper $name"
      exit 1
      ;;
  esac
done < <(sed -n 's/^TS_RT_ALWAYS_INLINE [^ ]* \([A-Za-z_][A-Za-z0-9_]*\)(.*/\1/p' "$header")

echo "[runtime-inline] PASS: large workers are out-of-line; only bounded fast paths and PICs stay inline"
