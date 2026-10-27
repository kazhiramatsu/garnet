#!/usr/bin/env bash
# The instruction-count A/B of two tsc-ts builds on the TypeScript 6.0.3 compiler project (one
# checker in the process itself, `--singleThreaded`: a forked checker's instructions are not in the
# parent's rusage; one CPU): the binaries alternate for `rounds` rounds under `/usr/bin/time -l`, whose
# "instructions retired" and "cycles elapsed" are what a slice is judged by (the wall clock on a
# shared machine drifts by more than most slices move), the emitted files of the two must agree, and
# the medians are printed.
#   scripts/tsc_ts_insn_ab.sh <rounds> <binary A> <binary B>
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rounds=${1:?rounds}; A=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); B=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
LIB="${TSC_TS_LIB_DIR:-$(ls -d "$ROOT"/build/tsc-ts/node_modules/@scriptc/cli-*/dist/lib/typescript/lib 2>/dev/null | head -1)}"
cd "$ROOT/build/typescript_603/source" || { echo "build/typescript_603/source missing" >&2; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
ARGS="-p src/compiler/tsconfig.json --singleThreaded --composite false --incremental false --declaration false --declarationMap false --emitDeclarationOnly false --isolatedDeclarations false --sourceMap false --pretty false"
one() { # <name> <binary>: appends "insn cycles real rss" to $W/<name>.txt
  rm -rf "$W/out_$1"
  TSAOT_CPUS=1 TSC_TS_LIB_DIR="$LIB" /usr/bin/time -l "$2" $ARGS --outDir "$W/out_$1" > "$W/$1.stdout" 2> "$W/t.err" || echo "[$1] exit $?" >&2
  awk '/instructions retired/ {i=$1} /cycles elapsed/ {c=$1} / real / {r=$1} /maximum resident/ {m=$1} END {printf "%d %d %s %.0f\n", i, c, r, m/1048576}' "$W/t.err" >> "$W/$1.txt"
}
for r in $(seq 1 "$rounds"); do one A "$A"; one B "$B"; done
d=$(diff -rq "$W/out_A" "$W/out_B" | wc -l | tr -d ' ')
echo "outputs: $([ "$d" = 0 ] && echo identical || echo "$d files differ")"
python3 - "$W/A.txt" "$W/B.txt" "$A" "$B" <<'PY'
import sys, statistics
rows = [[list(map(float, l.split())) for l in open(f)] for f in sys.argv[1:3]]
names = ["A " + sys.argv[3], "B " + sys.argv[4]]
med = []
for n, rs in zip(names, rows):
    m = [statistics.median(c) for c in zip(*rs)]
    med.append(m)
    print(f"{n}: insn {m[0]/1e9:.3f} G, cycles {m[1]/1e9:.3f} G, wall {m[2]:.2f} s, rss {m[3]:.0f} MB  (rounds: " + ", ".join(f"{r[0]/1e9:.3f}G/{r[2]:.2f}s" for r in rs) + ")")
print(f"B/A: insn {med[1][0]/med[0][0]:.4f}, cycles {med[1][1]/med[0][1]:.4f}, wall {med[1][2]/med[0][2]:.3f}")
PY
