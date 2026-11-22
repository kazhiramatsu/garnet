#!/usr/bin/env bash
# The forked workers of tsc-ts builds on the TypeScript 6.0.3 compiler project, each by its own
# instructions and cycles (TSAOT_FORK_TRACE's exit line: a worker's counts are its process's, which
# the parent's rusage does not carry). The wall clock of a default run is the parse of the largest
# file on one parse worker, then its check on one checker, so those two workers are the critical
# path; on a shared machine their instructions are what an A/B can read (the cycles follow the
# machine's load, the instructions do not). Configurations alternate for `rounds` rounds, type check
# only, and the medians are printed: the heaviest checker (the one that checks checker.ts), all
# checkers, the heaviest parse worker, all parse workers, and the checkers' peak resident sets.
#   scripts/tsc_ts_workers_ab.sh <rounds> <checkers> <label>=<binary>[;ENV=VALUE ...] ...
#   e.g. scripts/tsc_ts_workers_ab.sh 5 4 a=build/tsc_ts_native_a/tsc-ts "b=build/tsc_ts_native_b/tsc-ts;TSAOT_GC_NURSERY_BYTES=67108864"
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIG="$(pwd)"
[ $# -ge 3 ] || { echo "usage: $0 <rounds> <checkers> <label>=<binary>[;ENV=VALUE ...] ..." >&2; exit 2; }
N=$1; K=$2; shift 2
export TSC_TS_LIB_DIR="${TSC_TS_LIB_DIR:-$(ls -d "$ROOT"/build/tsc-ts/node_modules/@scriptc/cli-*/dist/lib/typescript/lib 2>/dev/null | head -1)}"
cd "$ROOT/build/typescript_603/source" || { echo "build/typescript_603/source missing" >&2; exit 2; }
ARGS="-p src/compiler/tsconfig.json --composite false --incremental false --declaration false --declarationMap false --emitDeclarationOnly false --isolatedDeclarations false --sourceMap false --pretty false --noEmit --checkers $K"
T=$(mktemp); trap 'rm -f "$T"' EXIT
for r in $(seq "$N"); do
  for spec in "$@"; do
    label=${spec%%=*}; rest=${spec#*=}; bin=${rest%%;*}; envs=""
    case "$rest" in *";"*) envs=${rest#*;} ;; esac
    case "$bin" in /*) ;; *) bin="$ORIG/$bin" ;; esac
    # shellcheck disable=SC2086  # the environment assignments and the arguments are word lists
    env $envs TSAOT_FORK_TRACE=1 "$bin" $ARGS 2>&1 >/dev/null | grep "^\[fork child\].*instructions" | sed "s/^/$label /" >> "$T"
    echo "$label END" >> "$T"
  done
done
python3 - "$T" <<'PY'
import sys, re, statistics, collections
runs = collections.OrderedDict(); cur = collections.defaultdict(list)
for l in open(sys.argv[1]):
    label, rest = l.split(None, 1)
    if rest.strip() == 'END':
        runs.setdefault(label, []).append(cur[label]); cur[label] = []; continue
    m = re.search(r'region used (\d+) MB, young collections (\d+), instructions ([0-9.]+) G, cycles ([0-9.]+) G, max rss (\d+) MB', l)
    if m: cur[label].append((int(m.group(1)) > 0, float(m.group(3)), float(m.group(4)), int(m.group(5))))
med = statistics.median
def top(ws, i): return max((w[i] for w in ws), default=0.0)
def tot(ws, i): return sum(w[i] for w in ws)
for label, rs in runs.items():
    ck = [[w for w in r if not w[0]] for r in rs]; pw = [[w for w in r if w[0]] for r in rs]
    print(f"{label}: heaviest checker insn {med(top(c, 1) for c in ck):.4f} G cycles {med(top(c, 2) for c in ck):.4f} G rss {med(top(c, 3) for c in ck):.0f} MB | "
          f"checkers insn {med(tot(c, 1) for c in ck):.3f} G cycles {med(tot(c, 2) for c in ck):.3f} G rss {med(tot(c, 3) for c in ck):.0f} MB | "
          f"heaviest parse worker insn {med(top(p, 1) for p in pw):.4f} G cycles {med(top(p, 2) for p in pw):.4f} G | "
          f"parse workers insn {med(tot(p, 1) for p in pw):.3f} G  ({len(rs)} runs, {len(ck[0])} checkers, {len(pw[0])} parse workers)")
PY
