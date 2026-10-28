#!/usr/bin/env bash
# The optional RegExp link (docs/regexp_vm_design.md): a generated C file without the
# TSAOT_NEEDS_REGEXP marker prepares no engine objects; one with it links runtime/regexp's engine
# and adapter, and the engine and the adapter answer over Latin-1 and UTF-16 input.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh"
. "$ROOT/scripts/lib/regexp_link_flags.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>"$tmp/rt.err"

cat > "$tmp/no_marker.c" <<'C'
#include "ts_rt.h"
int main(void) { return 0; }
C
tsaot_prepare_regexp_objs "$tmp/no_marker.c" "$tmp"
if (( ${#TSAOT_REGEXP_OBJS[@]} != 0 )); then
  echo "[regexp-link] FAIL: no marker still prepared RegExp objects"
  printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}"
  exit 1
fi

cat > "$tmp/needs_regexp.c" <<'C'
#include "ts_rt.h"
#define TSAOT_NEEDS_REGEXP 1
#include "regexp/ts_regexp_adapter.h"
#include "regexp/rx.h"
int main(void) {
  rx_error err;
  uint16_t pat[] = { 'a', '(', 'b', '+', ')' };
  rx_program* re = rx_compile(pat, 5, 0, &err);
  if (!re) return 2;
  if (rx_group_count(re) != 1) return 3;
  int32_t caps[4];
  if (rx_exec(re, "xxabbb", 6, 0, 0, caps) != 1) return 4;
  if (caps[0] != 2 || caps[1] != 6 || caps[2] != 3 || caps[3] != 6) return 5;
  rx_release(re);
  uint16_t pb[] = { 'B' };
  re = rx_compile(pb, 1, 0, &err);
  if (!re) return 7;
  uint16_t utf16_input[4] = { 'A', 0xd83d, 0xde00, 'B' };
  if (rx_exec(re, utf16_input, 4, 1, 0, caps) != 1) return 8;
  if (caps[0] != 3 || caps[1] != 4) return 9;
  rx_release(re);
  uint16_t bad[] = { '(' };
  if (rx_compile(bad, 1, 0, &err) != NULL || !err.msg) return 10;

  ts_regexp_adapter_init();
  tsv emoji_pat = ts_new_string("\360\237\230\200+", 5); ts_gc_root(&emoji_pat);
  tsv emoji_input = ts_new_string("x\360\237\230\200\360\237\230\200y", 10); ts_gc_root(&emoji_input);
  if (!ts_truthy(ts_regexp_adapter_test_tsv(emoji_pat, 0, emoji_input, NULL, NULL))) return 11;
  tsv dot_pat = ts_new_string("^.$", 3); ts_gc_root(&dot_pat);
  tsv emoji_single = ts_new_string("\360\237\230\200", 4); ts_gc_root(&emoji_single);
  if (ts_truthy(ts_regexp_adapter_test_tsv(dot_pat, 0, emoji_single, NULL, NULL))) return 12;
  if (!ts_truthy(ts_regexp_adapter_test_tsv(dot_pat, TSAOT_REGEXP_FLAG_UNICODE, emoji_single, NULL, NULL))) return 13;
  tsv obj = ts_regexp_new_literal(ts_new_string("(\\d+)-(\\d+)", 11), TSAOT_REGEXP_FLAG_GLOBAL, NULL, NULL); ts_gc_root(&obj);
  if (!ts_is_regexp(obj)) return 14;
  tsv s = ts_new_string("a 12-34 b 5-6", 13); ts_gc_root(&s);
  tsv m = ts_regexp_adapter_object_exec_tsv(obj, s);
  if (!ts_is_obj(m) || ts_array_len(m) != 3) return 15;
  tsv m2 = ts_regexp_adapter_object_exec_tsv(obj, s);
  if (!ts_is_obj(m2)) return 16;
  if (!ts_is_null(ts_regexp_adapter_object_exec_tsv(obj, s))) return 17;
  ts_gc_unroot(6);
  return 0;
}
C
tsaot_prepare_regexp_objs "$tmp/needs_regexp.c" "$tmp"
if (( ${#TSAOT_REGEXP_OBJS[@]} == 0 )); then
  echo "[regexp-link] FAIL: marker did not prepare the RegExp objects"
  exit 1
fi
printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}" | grep -q '/rx_engine\.o$' || {
  echo "[regexp-link] FAIL: the engine object was not prepared"
  printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}"
  exit 1
}

$CC "$tmp/needs_regexp.c" "$tmp/rt.o" "${TSAOT_REGEXP_OBJS[@]}" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/needs_regexp" 2>"$tmp/link.err"
if ! "$tmp/needs_regexp"; then
  echo "[regexp-link] FAIL: the linked program returned $?"
  exit 1
fi
echo "[regexp-link] PASS"
