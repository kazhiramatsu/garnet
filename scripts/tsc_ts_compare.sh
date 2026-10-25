#!/bin/bash
# Compare compilers of the TypeScript 6.0.3 compiler project (build/typescript_603/source,
# the tsc-ts benchmark's workload): interleaved rounds of each configuration, then the
# medians of wall, user and system time and the peak resident set, and whether every
# configuration's output matches the first one's (README.md, "Performance: tsc-ts").
#   usage: TSC_TS_LIB_DIR=<lib dir for garnet's tsc-ts> scripts/tsc_ts_compare.sh <rounds> <name>=<command> ...
#   e.g.   scripts/tsc_ts_compare.sh 9 tsgo=tsgo garnet=build/tsc_ts_native/tsc-ts "garnet4=build/tsc_ts_native/tsc-ts --checkers 4"
# Each command receives the project and emit options and its own --outDir. The peak
# resident set is the main process's (a forked checker's is not included); the CPU
# times include waited-for children.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/build/typescript_603/source" || { echo "build/typescript_603/source missing (scripts/build_typescript_native.sh fetches it)" >&2; exit 2; }
[ $# -ge 2 ] || { echo "usage: $0 <rounds> <name>=<command> ..." >&2; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
rounds=$1; shift
A="-p src/compiler/tsconfig.json --composite false --incremental false --declaration false --declarationMap false --emitDeclarationOnly false --isolatedDeclarations false --sourceMap false --pretty false"
for r in $(seq 1 "$rounds"); do
  for cfg in "$@"; do
    name=${cfg%%=*}; cmd=${cfg#*=}
    rm -rf "$W/out_$name"
    /usr/bin/time -l $cmd $A --outDir "$W/out_$name" > "$W/$name.stdout" 2> "$W/t.err"
    rc=$?; files=$(find "$W/out_$name" -type f | wc -l | tr -d ' ')
    awk -v n="$name" -v rc=$rc -v files="$files" '/real/ {w=$1; u=$3; s=$5} /maximum resident/ {m=$1} END {print n, w, u, s, m/1048576, rc, files}' "$W/t.err" >> "$W/all.txt"
  done
done
first=""
for cfg in "$@"; do
  name=${cfg%%=*}
  if [ -z "$first" ]; then first=$name; continue; fi
  d=$(diff -rq "$W/out_$first" "$W/out_$name" | wc -l | tr -d ' ')
  echo "outputs $name vs $first: $([ "$d" = 0 ] && echo identical || echo "$d files differ")"
done
python3 - "$W/all.txt" <<'PY'
import sys, statistics, collections
rows = collections.defaultdict(list)
for l in open(sys.argv[1]):
    p = l.split(); rows[p[0]].append((float(p[1]), float(p[2]), float(p[3]), float(p[4]), p[5], p[6]))
print(f"{'config':18s} {'wall med':>8s} {'min':>6s} {'user':>6s} {'sys':>5s} {'peakMB':>7s}  rc files  (n)")
for n, v in rows.items():
    med = lambda i: statistics.median(x[i] for x in v)
    print(f"{n:18s} {med(0):8.3f} {min(x[0] for x in v):6.3f} {med(1):6.2f} {med(2):5.2f} {med(3):7.0f}  {v[-1][4]} {v[-1][5]:>5s}  ({len(v)})")
PY
