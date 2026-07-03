#!/usr/bin/env bash
# Multi-file ESM bundler conformance: each tests/bundler/<name>/ dir is a module
# graph with an entry.ts; its native (bundled) output must match a node ESM run.
# Cases marked `# EXPECT-REJECT` must loud-reject (no silent miscompile).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
. "$ROOT/scripts/lib/mf.sh"
DIR="$ROOT/tests/bundler"
pass=0; fail=0
run() {
  local name="$1" dir="$2" expect="$3"
  local out; out=$(mf "$name" "$dir" 2>&1)
  if [ "$expect" = "reject" ]; then
    if printf "%s" "$out" | grep -q "REJECT"; then printf "%-30s REJECT-OK\n" "$name"; pass=$((pass+1));
    else printf "%-30s EXPECTED-REJECT-BUT:\n%s\n" "$name" "$out"; fail=$((fail+1)); fi
  else
    if printf "%s" "$out" | grep -q " OK$"; then printf "%-30s OK\n" "$name"; pass=$((pass+1));
    else printf "%s\n" "$out"; fail=$((fail+1)); fi
  fi
}
for d in "$DIR"/*/; do
  [ -f "$d/entry.ts" ] || continue
  name=$(basename "$d")
  expect=ok
  grep -rqs "EXPECT-REJECT" "$d" && expect=reject
  run "$name" "$d" "$expect"
done
echo "[bundler] PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
