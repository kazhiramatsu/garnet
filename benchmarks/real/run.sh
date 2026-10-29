#!/usr/bin/env bash
# A real TypeScript project under garnet against Node (docs/real_projects.md): the driver
# benchmarks/real/<name>/driver.ts (a fixed workload over the project's own sources, a checksum on
# stdout and its time on stderr) is copied into the project's clone in build/real/<name> as
# garnet-driver.ts beside a tsconfig for the compile (garnet-tsconfig.json), compiled with garnet,
# and the same sources are transpiled for Node (transpile_tree.js); both run `runs` times, the
# checksums must agree, and the median times are printed.
#   bash benchmarks/real/run.sh <name> [runs]
# TSAOT_REAL_PGO=auto|off|train (docs/pgo_design.md): `auto` (the default) applies a default.pgo and
# default.regexps an earlier training left next to garnet-driver.ts in the clone, `off` is the plain
# build (the earlier sessions' numbers), `train` runs the driver's own workload as the training run
# inside the clone and builds with its profile and its run-time regexps' native matchers.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="${1:?name}"; runs="${2:-3}"
proj="$ROOT/build/real/$name"; work="$ROOT/build/real/$name-work"
[ -d "$proj" ] || { echo "no clone at $proj"; exit 1; }
mkdir -p "$work"
# a project's compile environment (benchmarks/real/<name>/env.sh: TSAOT_DEFINE, the build-time constants both engines see)
[ -f "$ROOT/benchmarks/real/$name/env.sh" ] && . "$ROOT/benchmarks/real/$name/env.sh"
[ -f "$ROOT/benchmarks/real/$name/paths.js" ] && node "$ROOT/benchmarks/real/$name/paths.js" "$proj" "$ROOT/benchmarks/real/$name/tsconfig.json" "$proj/garnet-paths.json" > /dev/null
cp "$ROOT/benchmarks/real/$name/driver.ts" "$proj/garnet-driver.ts"
# the driver's companion sources (benchmarks/real/<name>/*.tsx: a JSX view), beside it as garnet-<file>
for f in "$ROOT/benchmarks/real/$name"/*.tsx; do [ -e "$f" ] && cp "$f" "$proj/garnet-$(basename "$f")"; done
# a project's stand-ins for third-party modules its benchmark configuration never calls (benchmarks/real/<name>/stubs)
if [ -d "$ROOT/benchmarks/real/$name/stubs" ]; then rm -rf "$proj/garnet-stubs"; cp -R "$ROOT/benchmarks/real/$name/stubs" "$proj/garnet-stubs"; fi
# the typings of third-party packages the stubs re-export (benchmarks/real/<name>/types.txt, one npm spec per line),
# installed once under <clone>/garnet-types
if [ -f "$ROOT/benchmarks/real/$name/types.txt" ] && [ ! -d "$proj/garnet-types/node_modules" ]; then
  mkdir -p "$proj/garnet-types" && echo '{ "name": "garnet-types", "private": true }' > "$proj/garnet-types/package.json"
  ( cd "$proj/garnet-types" && npm install --silent --no-package-lock --no-audit --no-fund $(cat "$ROOT/benchmarks/real/$name/types.txt") ) || { echo "[$name] npm install of the typings FAILED"; exit 1; }
fi
cp "$ROOT/benchmarks/real/$name/tsconfig.json" "$proj/garnet-tsconfig.json"
pgo_mode="${TSAOT_REAL_PGO:-auto}"
pgo_args=()
case "$pgo_mode" in
  off) pgo_args=(--pgo off) ;;
  train) pgo_args=(--pgo-train "cd '$proj' && \"\$TSAOT_PGO_BIN\" > /dev/null 2>&1") ;;
  auto) ;;
  *) echo "[$name] TSAOT_REAL_PGO must be auto, off or train (got $pgo_mode)"; exit 1 ;;
esac
echo "[$name] garnet build (pgo: $pgo_mode)"
( cd "$ROOT" && "$ROOT/garnet" "${pgo_args[@]}" -p "$proj/garnet-tsconfig.json" -o "$work/driver.c" "$proj/garnet-driver.ts" ) > "$work/build.log" 2>&1 \
  || { echo "[$name] garnet build FAILED:"; grep -v "^\s*$" "$work/build.log" | tail -25; exit 1; }
grep -o "(profile-guided: [^)]*)\|(regexps: [^)]*)" "$work/build.log" | sed "s/^/[$name] /"
# a workspace's bare specifiers for the Node side (benchmarks/real/<name>/paths.js writes it)
pathsArg=""; [ -f "$proj/garnet-paths.json" ] && pathsArg="$proj/garnet-paths.json"
echo "[$name] node transpile: $(ROOT="$ROOT" node "$ROOT/benchmarks/real/transpile_tree.js" "$proj" "$work/node" garnet-driver.ts $pathsArg 2>&1 | tr '\n' ' ')"
median() { sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }
tn=(); tg=()
for i in $(seq 1 "$runs"); do
  # both engines run inside the clone, so a driver's relative paths name the project's files
  ( cd "$proj" && "$work/driver" ) > "$work/out_native.txt" 2> "$work/err_native.txt" || { echo "[$name] native run FAILED:"; tail -5 "$work/err_native.txt"; exit 1; }
  ( cd "$proj" && node "$work/node/garnet-driver.mjs" ) > "$work/out_node.txt" 2> "$work/err_node.txt" || { echo "[$name] node run FAILED:"; tail -5 "$work/err_node.txt"; exit 1; }
  tg+=("$(grep -o '[0-9.]* ms' "$work/err_native.txt" | head -1 | cut -d' ' -f1)")
  tn+=("$(grep -o '[0-9.]* ms' "$work/err_node.txt" | head -1 | cut -d' ' -f1)")
done
if cmp -s "$work/out_native.txt" "$work/out_node.txt"; then echo "[$name] outputs identical: $(head -c 120 "$work/out_native.txt" | tr '\n' ' ')"
else echo "[$name] OUTPUTS DIFFER"; diff "$work/out_native.txt" "$work/out_node.txt" | head -6; fi
echo "[$name] garnet $(printf '%s\n' "${tg[@]}" | median) ms, node $(printf '%s\n' "${tn[@]}" | median) ms (median of $runs; all: garnet ${tg[*]} / node ${tn[*]})"
