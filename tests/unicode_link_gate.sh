#!/usr/bin/env bash
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
tsaot_prepare_unicode_objs "$tmp/no_marker.c" "$tmp"
if (( ${#TSAOT_UNICODE_OBJS[@]} != 0 )); then
  echo "[unicode-link] FAIL: no marker still prepared Unicode object"
  printf '%s\n' "${TSAOT_UNICODE_OBJS[@]}"
  exit 1
fi

cat > "$tmp/needs_unicode.c" <<'C'
#include "ts_rt.h"
#define TSAOT_NEEDS_UNICODE 1
#include "unicode/ts_unicode_adapter.h"
int main(void) {
  if (!ts_unicode_adapter_available()) return 0;
  tsv input = ts_new_string("e\314\201", 3);
  tsv form = ts_new_string("NFC", 3);
  ts_gc_root(&input); ts_gc_root(&form);
  tsv out = ts_unicode_normalize_tsv(input, form);
  ts_gc_root(&out);
  if (ts_str_len_fast(out) != 1) return 2;
  ts_gc_unroot(3);
  return 0;
}
C
tsaot_prepare_unicode_objs "$tmp/needs_unicode.c" "$tmp"
if (( ${#TSAOT_UNICODE_OBJS[@]} == 0 )); then
  echo "[unicode-link] FAIL: marker did not prepare Unicode object"
  exit 1
fi
if tsaot_quickjs_unicode_vendor_available; then
  printf '%s\n' "${TSAOT_UNICODE_OBJS[@]}" | grep -q '/libunicode\.o$' || {
    echo "[unicode-link] FAIL: vendored QuickJS libunicode object not prepared"
    printf '%s\n' "${TSAOT_UNICODE_OBJS[@]}"
    exit 1
  }
fi
$CC "$tmp/needs_unicode.c" "$tmp/rt.o" "${TSAOT_UNICODE_OBJS[@]}" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/needs_unicode" 2>"$tmp/link.err"
"$tmp/needs_unicode"

cat > "$tmp/both.c" <<'C'
#include "ts_rt.h"
#define TSAOT_NEEDS_REGEXP 1
#include "regexp/ts_regexp_adapter.h"
#define TSAOT_NEEDS_UNICODE 1
#include "unicode/ts_unicode_adapter.h"
int main(void) {
  return ts_regexp_adapter_available() || ts_unicode_adapter_available() ? 0 : 0;
}
C
tsaot_prepare_regexp_objs "$tmp/both.c" "$tmp"
tsaot_prepare_unicode_objs "$tmp/both.c" "$tmp"
if tsaot_quickjs_regexp_vendor_available && tsaot_quickjs_unicode_vendor_available; then
  n_unicode="$(printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}" "${TSAOT_UNICODE_OBJS[@]}" | grep -c '/libunicode\.o$')"
  if [[ "$n_unicode" != "1" ]]; then
    echo "[unicode-link] FAIL: shared libunicode object linked $n_unicode times"
    printf '%s\n' "${TSAOT_REGEXP_OBJS[@]}" "${TSAOT_UNICODE_OBJS[@]}"
    exit 1
  fi
fi
$CC "$tmp/both.c" "$tmp/rt.o" "${TSAOT_REGEXP_OBJS[@]}" "${TSAOT_UNICODE_OBJS[@]}" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/both" 2>"$tmp/both.link.err"
"$tmp/both"

echo "[unicode-link] PASS: marker controls optional Unicode object linkage"
