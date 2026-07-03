#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/mimalloc_flags.sh"
. "$ROOT/scripts/regexp_link_flags.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>"$tmp/rt.err"

cat > "$tmp/no_marker.c" <<'C'
#include "ts_rt.h"
int main(void) { return 0; }
C
tsaot_prepare_regexp_objs "$tmp/no_marker.c" "$tmp"
if (( ${#TSAOT_REGEXP_OBJS[@]} != 0 )); then
  echo "[regexp-link] FAIL: no marker still prepared RegExp object"
  printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}"
  exit 1
fi

cat > "$tmp/needs_regexp.c" <<'C'
#include "ts_rt.h"
#define TSAOT_NEEDS_REGEXP 1
#include "regexp/ts_regexp_adapter.h"
int main(void) {
  if (!ts_regexp_adapter_available()) return 0;
  char err[128];
  ts_regexp_compiled* re = ts_regexp_compile_utf8("a(b+)", 5, 0, err, sizeof(err));
  if (!re) return 2;
  if (ts_regexp_capture_count(re) != 2) return 3;
  ts_regexp_span caps[2];
  int rc = ts_regexp_exec_latin1(re, (const uint8_t*)"xxabbb", 6, 0, caps, 2);
  if (rc != TSAOT_REGEXP_OK) return 4;
  if (!caps[0].matched || caps[0].start != 2 || caps[0].end != 6) return 5;
  if (!caps[1].matched || caps[1].start != 3 || caps[1].end != 6) return 6;
  ts_regexp_free(re);

  re = ts_regexp_compile_utf8("B", 1, 0, err, sizeof(err));
  if (!re) return 7;
  uint16_t utf16_input[4] = { 'A', 0xd83d, 0xde00, 'B' };
  rc = ts_regexp_exec_utf16(re, utf16_input, 4, 0, caps, 1);
  if (rc != TSAOT_REGEXP_OK) return 8;
  if (!caps[0].matched || caps[0].start != 3 || caps[0].end != 4) return 9;
  ts_regexp_free(re);

  tsv emoji_pat = ts_new_string("\360\237\230\200+", 5); ts_gc_root(&emoji_pat);
  tsv emoji_input = ts_new_string("x\360\237\230\200\360\237\230\200y", 10); ts_gc_root(&emoji_input);
  if (!ts_truthy(ts_regexp_adapter_test_tsv(emoji_pat, 0, emoji_input))) return 10;
  tsv dot_pat = ts_new_string("^.$", 3); ts_gc_root(&dot_pat);
  tsv emoji_single = ts_new_string("\360\237\230\200", 4); ts_gc_root(&emoji_single);
  if (ts_truthy(ts_regexp_adapter_test_tsv(dot_pat, 0, emoji_single))) return 11;
  if (!ts_truthy(ts_regexp_adapter_test_tsv(dot_pat, TSAOT_REGEXP_FLAG_UNICODE, emoji_single))) return 12;
  ts_gc_unroot(4);
  return 0;
}
C
tsaot_prepare_regexp_objs "$tmp/needs_regexp.c" "$tmp"
if (( ${#TSAOT_REGEXP_OBJS[@]} == 0 )); then
  echo "[regexp-link] FAIL: marker did not prepare RegExp object"
  exit 1
fi
if tsaot_quickjs_regexp_vendor_available; then
  printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}" | grep -q '/libregexp\.o$' || {
    echo "[regexp-link] FAIL: vendored QuickJS libregexp object not prepared"
    printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}"
    exit 1
  }
  printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}" | grep -q '/libunicode\.o$' || {
    echo "[regexp-link] FAIL: vendored QuickJS libunicode object not prepared"
    printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}"
    exit 1
  }
fi

$CC "$tmp/needs_regexp.c" "$tmp/rt.o" "${TSAOT_REGEXP_OBJS[@]}" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/needs_regexp" 2>"$tmp/link.err"
"$tmp/needs_regexp"

echo "[regexp-link] PASS: marker controls optional RegExp object linkage"
