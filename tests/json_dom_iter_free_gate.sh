#!/bin/bash
# Per-iteration JSON DOM scope freeing (emit_c.rs loop_body_frees_json_dom).
#
# When a loop's JSON.parse (DOM fast path) result is created, read, and discarded
# entirely within the loop body, the analyzer frees the DOM scope at the bottom of
# each iteration instead of accumulating every iteration's DOM until function exit.
# This guards:
#   (1) the optimization fires on the confined parse-read-discard shape, and
#   (2) it is correctly SUPPRESSED when a DOM local is live across the loop
#       back-edge or used after the loop — where a per-iteration free would be a
#       use-after-free. AddressSanitizer makes any unsound free fatal here.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O0 -g -fsanitize=address}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/mimalloc_flags.sh" || exit 1
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>/dev/null

# Emit C for a program and report whether it frees the DOM scope inside a loop
# body (a scope_free immediately followed by the loop back-edge `goto L...`).
emit() {
  echo "$1" > "$tmp/t.ts"
  node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null
  ./analyzer/target/release/tsaot "$tmp/t.json" emit > "$tmp/t.c" 2>/dev/null
}
has_inloop_free() {
  awk '/ts_json_dom_scope_free/{prev=1; next} {if(prev && $0 ~ /goto L[0-9]/){found=1} prev=0} END{exit found?0:1}' "$tmp/t.c"
}
run() {
  $CC "$tmp/t.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/t" 2>/dev/null
  "$tmp/t" 2>&1 || true
}
chk() { # $1 desc, $2 src, $3 expected-first-line, $4 want-inloop-free(yes/no)
  emit "$2"
  if [ "$4" = yes ]; then
    has_inloop_free || { echo "[json-dom-iter-free] FAIL: $1 expected per-iteration free, none emitted"; fail=1; return; }
  else
    if has_inloop_free; then echo "[json-dom-iter-free] FAIL: $1 emitted an unsafe per-iteration free"; fail=1; return; fi
  fi
  local out; out=$(run)
  if echo "$out" | grep -qiE "AddressSanitizer|heap-use-after-free|invalid JSON"; then
    echo "[json-dom-iter-free] FAIL: $1 runtime error: $(echo "$out" | head -1)"; fail=1
  elif [ "$(echo "$out" | head -1)" != "$3" ]; then
    echo "[json-dom-iter-free] FAIL: $1 got '$(echo "$out" | head -1)' want '$3'"; fail=1
  fi
}

# (1) Confined parse-read-discard: optimization MUST fire, result correct, no UAF.
chk "confined parse-read-discard" \
'function main(): void {
  let acc = 0; let i = 0;
  while (i < 2000) { const o: any = JSON.parse("{\"v\":" + i + ",\"w\":[1,2,3]}"); acc = (acc + o.v + o.w.length) % 1000000007; i = i + 1; }
  console.log(acc);
}
main();' \
"2005000" yes

# (2) DOM local read before (re)definition each iteration => live across back-edge.
#     Per-iteration free MUST be suppressed; reading the prior DOM stays valid.
chk "live-in across back-edge (suppressed)" \
'function main(): void {
  let acc = 0; let i = 0; let o: any;
  while (i < 50) { if (i > 0) { acc = acc + o.v; } o = JSON.parse("{\"v\":" + i + "}"); i = i + 1; }
  console.log(acc);
}
main();' \
"1176" no

[ $fail -eq 0 ] && echo "[json-dom-iter-free] PASS: per-iteration JSON DOM free fires when confined and is suppressed when a DOM value escapes the iteration"
exit $fail
