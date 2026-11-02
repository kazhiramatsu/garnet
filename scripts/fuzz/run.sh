#!/usr/bin/env bash
# A differential fuzzer against Node: random programs, each compiled by garnet and run under both engines.
#   bash scripts/fuzz/run.sh numbers|statements <first-seed> <last-seed>
# One program at a time at nice 12. What differs is kept in build/fuzz/found (`<kind><seed>.ts`, `.v8`, `.aot`), a reject too;
# scripts/fuzz/reduce.py cuts a program down. A seed names a program, so a finding can be run again by anyone.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
kind=${1:?numbers or statements}; from=${2:?first seed}; to=${3:?last seed}
W="$ROOT/build/fuzz/work"; F="$ROOT/build/fuzz/found"; mkdir -p "$W" "$F"
n=0; bad=0; rej=0
for s in $(seq "$from" "$to"); do
  p="$W/$kind$s"; python3 "$ROOT/scripts/fuzz/gen_$kind.py" "$s" > "$p.ts"
  if ! nice -n 12 "$ROOT/garnet" -o "$p.c" "$p.ts" > "$p.log" 2>&1; then
    rej=$((rej+1)); cp "$p.ts" "$p.log" "$F/"; echo "BUILD $s: $(grep -m1 -E 'error|Error|reject|UNSUPPORTED' "$p.log" | cut -c1-120)"; continue
  fi
  node "$ROOT/scripts/fuzz/transpile.js" "$p.ts"; node "$p.mjs" > "$p.v8" 2>&1
  perl -e 'alarm 20; exec @ARGV' "$p" > "$p.aot" 2>&1
  n=$((n+1))
  if ! cmp -s "$p.v8" "$p.aot"; then
    bad=$((bad+1)); cp "$p.ts" "$p.v8" "$p.aot" "$F/"; echo "DIFF $s: $(diff "$p.v8" "$p.aot" | sed -n 2,4p | tr '\n' ' ' | cut -c1-150)"
  fi
  rm -f "$p" "$p.c" "$p.mjs" "$p.json" "$p.l.json" "$p.lsites.json"
done
echo "[fuzz] $kind ran=$n diff=$bad rejected=$rej"
