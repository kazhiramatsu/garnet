#!/usr/bin/env bash
# The hono middleware survey (docs/real_projects.md "hono: the middleware survey"): every driver in
# benchmarks/real/hono_survey/drivers (one middleware, helper or API surface of hono each) is copied
# into the hono clone (build/real/hono) as garnet-survey-<name>.ts beside the compile options of
# benchmarks/real/hono_app (garnet-tsconfig.json: jsxImportSource ./src/jsx), run under Node
# (transpile_tree.js, the same sources) and compiled and run under garnet, and the two outputs are
# compared. The verdict per driver: OK (identical), DIFF, REJECT (the exporter's unsupported
# construct), TYPE-ERR (TypeScript refuses the driver: fix the driver), BUILD-FAIL (the C did not
# compile), THROW (an uncaught exception or a non-zero exit); NODE-FAIL marks a driver Node cannot
# run either. Outputs and logs stay in build/real/hono_survey-work/<name>.*.
#   bash benchmarks/real/hono_survey/run.sh [name-filter-regex]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
proj="$ROOT/build/real/hono"; work="$ROOT/build/real/hono_survey-work"
[ -d "$proj" ] || { echo "no hono clone at $proj"; exit 1; }
mkdir -p "$work"
export ROOT NO_COLOR=1
filter="${1:-}"
cp "$ROOT/benchmarks/real/hono_app/tsconfig.json" "$proj/garnet-tsconfig.json"
for f in "$ROOT/benchmarks/real/hono_survey/drivers"/*; do cp "$f" "$proj/garnet-survey-$(basename "$f")"; done
printf "%-18s %-10s %s\n" DRIVER VERDICT DETAIL
ok=0; total=0
for f in "$ROOT/benchmarks/real/hono_survey/drivers"/*.ts "$ROOT/benchmarks/real/hono_survey/drivers"/*.tsx; do
  [ -e "$f" ] || continue
  base=$(basename "$f"); name="${base%.tsx}"; name="${name%.ts}"
  [[ "$name" == _* ]] && continue
  [[ -n "$filter" && ! "$name" =~ $filter ]] && continue
  total=$((total+1))
  entry="garnet-survey-$base"; stem="${entry%.tsx}"; stem="${stem%.ts}"
  rm -rf "$work/node-$name"
  node "$ROOT/benchmarks/real/transpile_tree.js" "$proj" "$work/node-$name" "$entry" > "$work/$name.transpile.log" 2>&1
  ( cd "$proj" && perl -e 'alarm shift; exec @ARGV' 60 node "$work/node-$name/$stem.mjs" > "$work/$name.node.out" 2> "$work/$name.node.err" ); nrc=$?
  ( cd "$ROOT" && perl -e 'alarm shift; exec @ARGV' 900 ./garnet --pgo off -p "$proj/garnet-tsconfig.json" -o "$work/$name.c" "$proj/$entry" > "$work/$name.build.log" 2>&1 ); brc=$?
  detail=""; verdict=""
  if [ $brc -ne 0 ]; then
    if grep -q "UNSUPPORTED" "$work/$name.build.log"; then verdict=REJECT; detail=$(grep -m1 "UNSUPPORTED" "$work/$name.build.log" | sed -E 's/.*UNSUPPORTED construct: //' | cut -c1-150)
    elif grep -q "error TS" "$work/$name.build.log"; then verdict=TYPE-ERR; detail=$(grep -m1 "error TS" "$work/$name.build.log" | cut -c1-150)
    else verdict=BUILD-FAIL; detail=$(grep -m1 -i "error" "$work/$name.build.log" | cut -c1-150); fi
  else
    ( cd "$proj" && perl -e 'alarm shift; exec @ARGV' 60 "$work/$name" > "$work/$name.garnet.out" 2> "$work/$name.garnet.err" ); grc=$?
    if [ $grc -ne 0 ]; then verdict=THROW; detail="rc=$grc $(tail -1 "$work/$name.garnet.err" | cut -c1-140)"
    elif cmp -s "$work/$name.node.out" "$work/$name.garnet.out"; then verdict=OK; ok=$((ok+1))
    else verdict=DIFF; detail=$(diff "$work/$name.node.out" "$work/$name.garnet.out" | grep -m2 "^[<>]" | tr '\n' ' ' | cut -c1-150); fi
  fi
  [ $nrc -ne 0 ] && detail="NODE-FAIL(rc=$nrc: $(tail -1 "$work/$name.node.err" | cut -c1-80)) $detail"
  printf "%-18s %-10s %s\n" "$name" "$verdict" "$detail"
done
echo "[hono-survey] OK=$ok / $total"
