#!/bin/bash
# Typed-emit port harness: per fixture, run the Rust `tsaot <ir> emit` and the
# TS `main.js <ir> emitc`, byte-compare. Reports identical / UNPORTED / DIFF
# counts, the UNPORTED-reason histogram, and for DIFFs the first differing line
# (the porting work-list, frequency-ordered — Phase 1 style).
# Usage: scripts/emitc_diff.sh [name-filter]
set -u
cd "$(dirname "$0")/.."
RUST=analyzer/target/release/tsaot
W="${TMPDIR:-/tmp}/emitc_diff"
FILTER="${1:-}"
mkdir -p "$W/json"

# batch typed export (cached: reuse if list unchanged and json dir populated)
LIST="$W/list.tsv"; : > "$LIST"
for ts in $(find tests/conformance/exhaustive -name "*.ts" | sort); do
  slug=$(echo "${ts#tests/conformance/exhaustive/}" | tr '/' '__'); slug="${slug%.ts}"
  printf '%s\t%s\n' "$slug" "$ts" >> "$LIST"
done
if [ ! -f "$W/json/.stamp" ] || [ "$LIST" -nt "$W/json/.stamp" ]; then
  node exporter/exporter.js --batch "$LIST" "$W/json" > "$W/exp.status" 2>"$W/exp.err" || true
  touch "$W/json/.stamp"
fi

# 凍結双子との既知差分（silent miscompile 修正の随伴。scripts/frozen_known_diffs.tsv
# の scope=parity 行）。KNOWN として別集計し PASS 判定から除外する。
KNOWN_SLUGS=$(awk -F'\t' '$1=="parity"{gsub("/","_",$2); print $2}' scripts/frozen_known_diffs.tsv 2>/dev/null)

same=0; unported=0; diff_=0; known=0; skip=0
: > "$W/unported.txt"; : > "$W/firstdiff.txt"; : > "$W/knowndiff.txt"
while IFS=$'\t' read -r slug path; do
  case "$slug" in *"$FILTER"*) ;; *) continue ;; esac
  prog="$W/json/$slug.program.json"
  [ -f "$prog" ] || { skip=$((skip+1)); continue; }
  # The frozen TS emitter predates both property PICs and shadow root frames.
  # Keep this mechanical byte oracle on the explicit legacy mode while
  # production emission uses both optimizations by default.
  TSAOT_PROP_PIC=0 TSAOT_FRAME_ROOTS=0 "$RUST" "$prog" emit > "$W/r.c" 2>/dev/null || { skip=$((skip+1)); continue; }
  if ! node analyzer_ts/dist/main.js "$prog" emitc > "$W/t.c" 2>"$W/t.err"; then
    if grep -q "^UNPORTED:" "$W/t.err"; then
      unported=$((unported+1))
      grep "^UNPORTED:" "$W/t.err" | sed 's/^UNPORTED: //' >> "$W/unported.txt"
    else
      diff_=$((diff_+1)); echo "$slug: CRASH $(head -c 100 "$W/t.err" | tr '\n' ' ')" >> "$W/firstdiff.txt"
    fi
    continue
  fi
  if cmp -s "$W/r.c" "$W/t.c"; then
    same=$((same+1))
  elif printf '%s\n' "$KNOWN_SLUGS" | grep -qx "$slug"; then
    known=$((known+1)); echo "$slug" >> "$W/knowndiff.txt"
  else
    diff_=$((diff_+1))
    # first differing line (the porting target)
    fd=$(diff "$W/r.c" "$W/t.c" | head -4 | tr '\n' ' ' | head -c 160)
    echo "$slug: $fd" >> "$W/firstdiff.txt"
  fi
done < "$LIST"

echo "emitc: identical=$same UNPORTED=$unported DIFF=$diff_ KNOWN=$known skip=$skip"
if [ -s "$W/knowndiff.txt" ]; then
  echo "--- known frozen diffs (allowlist: scripts/frozen_known_diffs.tsv) ---"
  cat "$W/knowndiff.txt"
fi
echo "--- UNPORTED histogram ---"
sort "$W/unported.txt" | uniq -c | sort -rn | head -15
echo "--- first-diff samples (work-list) ---"
sort "$W/firstdiff.txt" | awk -F: '{print $2}' | sort | uniq -c | sort -rn | head -10
head -5 "$W/firstdiff.txt"
