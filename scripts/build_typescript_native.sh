#!/usr/bin/env bash
# Build unmodified TypeScript compiler algorithms against a synchronous C System.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <TypeScript-6.0.3-source> [work-directory]" >&2
  exit 2
fi
TS_ROOT="$(cd "$1" && pwd)"
mkdir -p "${2:-$ROOT/build/typescript_native}"
WORK="$(cd "${2:-$ROOT/build/typescript_native}" && pwd)"
SOURCE="$WORK/source"
test -f "$TS_ROOT/src/compiler/_namespaces/ts.ts"
test -d "$TS_ROOT/node_modules"
test -f "$TS_ROOT/built/local/tsc.js"
test "$(node "$TS_ROOT/built/local/tsc.js" --version)" = 'Version 6.0.3'
python3 - "$TS_ROOT" "$SOURCE" "$ROOT" <<'PY'
import pathlib, shutil, sys
upstream, source, repo = map(pathlib.Path, sys.argv[1:])
if source.exists():
    raise SystemExit(f"Refusing to overwrite an existing source copy: {source}")
source.mkdir()
shutil.copytree(upstream / "src", source / "src")
for file in upstream.glob("*.json"):
    shutil.copy2(file, source / file.name)
(source / "node_modules").symlink_to(upstream / "node_modules", target_is_directory=True)
shutil.copy2(repo / "benchmarks/typescript_native/driver.ts", source / "garnet-native-driver.ts")
PY
(
  cd "$SOURCE"
  node --max-old-space-size=4096 "$ROOT/exporter/exporter.js" \
    --project src/compiler/tsconfig.json garnet-native-driver.ts \
    "$WORK/program.json" "$WORK/labels.json"
)
# The generated C as parallel units (docs/build_split_design.md; main lives in
# the data unit), or with TSAOT_NATIVE_UNITS=0 as one file.
UNITS="${TSAOT_NATIVE_UNITS:-1}"
if [[ "$UNITS" == "1" ]]; then
  rm -rf "$WORK/units"
  "$ROOT/analyzer/target/release/tsaot" "$WORK/program.json" emit --units "$WORK/units" > "$WORK/units.order"
  MAIN_C="$WORK/units/data.c"; MARKERS_C="$WORK/units/prog.h"
else
  "$ROOT/analyzer/target/release/tsaot" "$WORK/program.json" emit > "$WORK/compiler.c"
  MAIN_C="$WORK/compiler.c"; MARKERS_C="$WORK/compiler.c"
fi
python3 - "$MAIN_C" "$UNITS" <<'PY'
import json, os, pathlib, re, sys
file = pathlib.Path(sys.argv[1])
units = sys.argv[2] == "1"
code = file.read_text()
assert code.count('int main(void){') == 1
assert code.count('  ts_setup_globals();') == 1
code = code.replace('int main(void){', 'int main(int argc, char** argv){')
code = code.replace('  ts_setup_globals();',
                    '  ts_setup_globals();\n  garnet_native_system_init(argc, argv);')
exceptions = []
if units:
    # the cold functions are units of their own, compiled at -O0
    order = file.parent.with_name("units.order").read_text().split("\n")
    exceptions = [dict(unit=l.split()[0]) for l in order if l.endswith(" cold")]
elif os.environ.get("TSAOT_NATIVE_COLD_O0") == "1":
    # Generic entries `fn_X(tsv* args, int nargs)` and direct entries `fn_X_d(...)`.
    # A direct entry may return a raw number or boolean (typed returns, Session 350).
    for match in re.finditer(r'^static (?:tsv|int|double|long long) (fn_\d+_\w+)\((?:tsv\* args, int nargs|[^()]*)\)\{', code, re.M):
        end = code.find('\n}\n', match.end()) + 3
        lines = code.count('\n', match.start(), end)
        if lines >= 10000 or (lines >= 2000 and re.search(r'_create[A-Z]', match[1])):
            exceptions.append(dict(offset=match.start(), function=match[1], lines=lines))
    annotation = ('#if defined(__clang__)\n__attribute__((optnone, noinline))\n'
                  '#elif defined(__GNUC__)\n__attribute__((optimize("O0"), noinline))\n#endif\n')
    for item in reversed(exceptions):
        offset = item.pop("offset")
        code = code[:offset] + annotation + code[offset:]
(file.parent.parent if units else file.parent).joinpath("optimization_exceptions.json").write_text(json.dumps(exceptions, indent=2) + "\n")
file.write_text(code)
PY
CC="${TSAOT_HOST_CC:-cc -O2 -g -fno-omit-frame-pointer}"
# O0 is the bring-up default; set TSAOT_NATIVE_CC explicitly for speed comparisons.
GEN_CC="${TSAOT_NATIVE_CC:-cc -O0 -g -fno-omit-frame-pointer}"
TSAOT_USE_MIMALLOC="${TSAOT_USE_MIMALLOC:-1}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh"
. "$ROOT/scripts/lib/regexp_link_flags.sh"
stats_flags=""
if [[ "${TSAOT_NATIVE_STATS:-0}" == 1 ]]; then
  stats_flags='-DTSAOT_RT_STATS'
  GEN_CC="$GEN_CC $stats_flags"
fi
$CC $stats_flags -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$WORK/rt.o"
$CC -c "$ROOT/benchmarks/typescript_native/host.c" -I"$ROOT/runtime" -o "$WORK/host.o"
tsaot_prepare_regexp_objs "$MARKERS_C" "$WORK"
tsaot_prepare_unicode_objs "$MARKERS_C" "$WORK"
tsaot_prepare_fetch_runtime "$MARKERS_C" "$WORK" "$WORK/rt.o"
if [[ -n "${TSAOT_MIMALLOC_ACTIVE:-}" ]]; then
  GEN_CC="$GEN_CC -DTSAOT_USE_MIMALLOC -I$ROOT/third_party/mimalloc/include"
fi
if [[ "$UNITS" == "1" ]]; then
  . "$ROOT/scripts/lib/units.sh"
  TSAOT_UNITS_CC="$GEN_CC" \
  TSAOT_UNITS_CFLAGS="-include $ROOT/benchmarks/typescript_native/host.h -I$ROOT/runtime" \
    tsaot_units_build "$WORK/units" "$WORK/tsc-native" "$WORK/host.o" "$TSAOT_FETCH_RT_OBJ_ARG" \
      $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS
else
  $GEN_CC -c -include "$ROOT/benchmarks/typescript_native/host.h" \
    "$WORK/compiler.c" -I"$ROOT/runtime" -o "$WORK/compiler.o"
  $GEN_CC "$WORK/compiler.o" "$WORK/host.o" "$TSAOT_FETCH_RT_OBJ_ARG" \
    $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS \
    -o "$WORK/tsc-native"
fi
python3 - "$WORK" "$TS_ROOT" "$CC" "$GEN_CC" "$stats_flags" "$UNITS" "${TSAOT_UNITS_LTO:-1}" <<'PY'
import json, pathlib, sys
work, upstream = map(pathlib.Path, sys.argv[1:3])
units = sys.argv[6] == "1"
metadata = dict(version="6.0.3", upstream=str(upstream), source=str(work / "source"),
                lib_dir=str(upstream / "built/local"), runtime_cc=sys.argv[3],
                generated_cc=sys.argv[4], runtime_stats=bool(sys.argv[5]),
                units=units, thin_lto=units and sys.argv[7] == "1",
                optimization_exceptions=json.loads((work / "optimization_exceptions.json").read_text()))
(work / "build.json").write_text(json.dumps(metadata, indent=2) + "\n")
PY
GARNET_TSC_LIB_DIR="$TS_ROOT/built/local" "$WORK/tsc-native" --version
