#!/usr/bin/env bash
# Build vercel-labs/tsc-ts (a TypeScript port of tsgo) with garnet, one thread:
# benchmarks/tsc_ts_native/README.md, docs/tsc_ts_native_design.md.
#   usage: scripts/build_tsc_ts_native.sh <tsc-ts checkout> [work-directory]
# The checkout is left unchanged: its packages/tsc-ts/src is copied next to
# the garnet entry and the Node module shims (benchmarks/tsc_ts_native/garnet).
# The build is profile-guided (docs/pgo_design.md): an instrumented build is
# trained on the TypeScript compiler project (build/typescript_603) and the
# profile, written to <work>/default.pgo, guides the final build. TSAOT_PGO=off
# builds plain, TSAOT_PGO=<file> applies that profile, TSAOT_PGO_TRAIN='<cmd>'
# trains with another command (the instrumented executable is $TSAOT_PGO_BIN).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <tsc-ts checkout> [work-directory]" >&2
  exit 2
fi
CHECKOUT="$(cd "$1" && pwd)"
PKG="$CHECKOUT/packages/tsc-ts"
test -f "$PKG/src/main.ts"
mkdir -p "${2:-$ROOT/build/tsc_ts_native}"
WORK="$(cd "${2:-$ROOT/build/tsc_ts_native}" && pwd)"
SOURCE="$WORK/source"
python3 - "$PKG" "$SOURCE" "$ROOT" <<'PY'
import pathlib, shutil, sys
pkg, source, repo = map(pathlib.Path, sys.argv[1:])
if source.exists():
    raise SystemExit(f"Refusing to overwrite an existing source copy: {source}")
source.mkdir(parents=True)
shutil.copytree(pkg / "src", source / "src")
shutil.copy2(pkg / "package.json", source / "package.json")   # "type": "module"
shutil.copytree(repo / "benchmarks/tsc_ts_native/garnet", source / "garnet")
shutil.copy2(repo / "benchmarks/tsc_ts_native/tsconfig.json", source / "tsconfig.json")
PY
(
  cd "$SOURCE"
  node --max-old-space-size=8192 "$ROOT/exporter/exporter.js" \
    --project tsconfig.json garnet/main.ts "$WORK/program.json" "$WORK/labels.json"
)
# The generated C as parallel units (docs/build_split_design.md; main lives in
# the data unit), or with TSAOT_NATIVE_UNITS=0 as one file.
UNITS="${TSAOT_NATIVE_UNITS:-1}"
if [[ "$UNITS" == "1" ]]; then
  rm -rf "$WORK/units"
  "$ROOT/analyzer/target/release/tsaot" "$WORK/program.json" emit --units "$WORK/units" > "$WORK/units.order"
  MAIN_C="$WORK/units/data.c"; MARKERS_C="$WORK/units/prog.h"
else
  "$ROOT/analyzer/target/release/tsaot" "$WORK/program.json" emit > "$WORK/tsc-ts.c"
  MAIN_C="$WORK/tsc-ts.c"; MARKERS_C="$WORK/tsc-ts.c"
fi
python3 - "$MAIN_C" "$UNITS" <<'PY'
import json, os, pathlib, re, sys
file = pathlib.Path(sys.argv[1])
units = sys.argv[2] == "1"
code = file.read_text()
exceptions = []
if units:
    # the cold functions are units of their own, compiled at -O0
    order = file.parent.with_name("units.order").read_text().split("\n")
    exceptions = [dict(unit=l.split()[0]) for l in order if l.endswith(" cold")]
elif os.environ.get("TSAOT_NATIVE_COLD_O0") == "1":
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
GEN_CC="${TSAOT_NATIVE_CC:-cc -O0 -g -fno-omit-frame-pointer}"
TSAOT_USE_MIMALLOC="${TSAOT_USE_MIMALLOC:-1}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh"
. "$ROOT/scripts/lib/regexp_link_flags.sh"
. "$ROOT/scripts/lib/pgo.sh"
if [[ -n "${TSAOT_MIMALLOC_ACTIVE:-}" ]]; then
  GEN_CC="$GEN_CC -DTSAOT_USE_MIMALLOC -I$ROOT/third_party/mimalloc/include"
fi
# One pass of the native build: the runtime, the host, the optional runtime
# objects and the program, compiled with the pass's extra flags (none, the
# instrumentation, or a profile) into the pass's directory.
native_build() { # <extra cflags> <output executable> <pass directory>
  local extra="$1" out="$2" pw="$3"
  local CC="$CC${extra:+ $extra}" GEN_CC="$GEN_CC${extra:+ $extra}"
  mkdir -p "$pw"
  # the instrumented objects are keyed by this build's directory: they would
  # never be reused, so they bypass the shared cache
  case "$extra" in *-fprofile-generate*) local TSAOT_UNITS_CACHE="$pw/unit-cache" ;; esac
  $CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$pw/rt.o"
  tsaot_prepare_regexp_objs "$MARKERS_C" "$pw"
  tsaot_prepare_unicode_objs "$MARKERS_C" "$pw"
  tsaot_prepare_fetch_runtime "$MARKERS_C" "$pw" "$pw/rt.o"
  if [[ "$UNITS" == "1" ]]; then
    . "$ROOT/scripts/lib/units.sh"
    TSAOT_UNITS_CC="$GEN_CC" \
    TSAOT_UNITS_CFLAGS="-I$ROOT/runtime" \
      tsaot_units_build "$WORK/units" "$out" "$TSAOT_FETCH_RT_OBJ_ARG" \
        $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS
  else
    $GEN_CC -c "$WORK/tsc-ts.c" -I"$ROOT/runtime" -o "$pw/tsc-ts.o"
    $GEN_CC "$pw/tsc-ts.o" "$TSAOT_FETCH_RT_OBJ_ARG" \
      $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS \
      -o "$out"
  fi
}
# The profile-guided build (docs/pgo_design.md): the default trains an
# instrumented build on the TypeScript compiler project with one checker (the
# measured workload) and applies the profile; TSAOT_PGO=off builds plain,
# TSAOT_PGO=<file> applies that profile.
PGO="${TSAOT_PGO:-train}"
PGO_PROFILE=""
PGO_TRAINED_WITH=""
case "$PGO" in
  off)
    native_build "" "$WORK/tsc-ts" "$WORK/pass" ;;
  train)
    tsaot_pgo_supported "$CC" || { echo "[pgo] the profile-guided build needs clang (TSAOT_PGO=off builds plain)" >&2; exit 1; }
    tsaot_pgo_profdata > /dev/null || exit 1
    TRAIN="${TSAOT_PGO_TRAIN:-}"
    if [[ -z "$TRAIN" ]]; then
      TS_SRC="$ROOT/build/typescript_603/source"
      LIB="${TSC_TS_LIB_DIR:-$(ls -d "$CHECKOUT"/node_modules/@scriptc/cli-*/dist/lib/typescript/lib 2>/dev/null | head -1)}"
      if [[ ! -f "$TS_SRC/src/compiler/tsconfig.json" || -z "$LIB" ]]; then
        echo "[pgo] no training workload at hand: the TypeScript compiler project ($TS_SRC/src/compiler) and its lib directory (TSC_TS_LIB_DIR, or the checkout's @scriptc package) are needed; set TSAOT_PGO_TRAIN='<command>' or TSAOT_PGO=off" >&2
        exit 1
      fi
      TRAIN="cd '$TS_SRC' && TSAOT_CPUS=1 TSC_TS_LIB_DIR='$LIB' \"\$TSAOT_PGO_BIN\" -p src/compiler/tsconfig.json --composite false --incremental false --declaration false --declarationMap false --emitDeclarationOnly false --isolatedDeclarations false --sourceMap false --pretty false --checkers 1 --outDir '$WORK/pgo/out' > /dev/null"
    fi
    native_build "$(tsaot_pgo_gen_flags "$WORK/pgo/raw")" "$WORK/tsc-ts.pgo-gen" "$WORK/pass_gen"
    echo "[pgo] training run: $TRAIN"
    tsaot_pgo_train "$TRAIN" "$WORK/tsc-ts.pgo-gen" "$WORK/pgo/raw" "$WORK/default.pgo"
    rm -rf "$WORK/tsc-ts.pgo-gen" "$WORK/pgo" "$WORK/pass_gen"
    PGO_PROFILE="$WORK/default.pgo"
    PGO_TRAINED_WITH="$TRAIN"
    echo "[pgo] profile $PGO_PROFILE ($(du -k "$PGO_PROFILE" | cut -f1) KB)"
    native_build "$(tsaot_pgo_use_flags "$PGO_PROFILE")" "$WORK/tsc-ts" "$WORK/pass" ;;
  *)
    [[ -f "$PGO" ]] || { echo "[pgo] TSAOT_PGO: no such profile: $PGO" >&2; exit 1; }
    PGO_PROFILE="$(cd "$(dirname "$PGO")" && pwd)/$(basename "$PGO")"
    native_build "$(tsaot_pgo_use_flags "$PGO_PROFILE")" "$WORK/tsc-ts" "$WORK/pass" ;;
esac
python3 - "$WORK" "$CHECKOUT" "$CC" "$GEN_CC" "$UNITS" "${TSAOT_UNITS_LTO:-1}" "$PGO" "$PGO_PROFILE" "$PGO_TRAINED_WITH" <<'PY'
import json, pathlib, subprocess, sys
work, checkout = map(pathlib.Path, sys.argv[1:3])
commit = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
units = sys.argv[5] == "1"
metadata = dict(checkout=str(checkout), commit=commit, source=str(work / "source"),
                runtime_cc=sys.argv[3], generated_cc=sys.argv[4],
                units=units, thin_lto=units and sys.argv[6] == "1",
                pgo=dict(mode=sys.argv[7], profile=sys.argv[8] or None, trained_with=sys.argv[9] or None),
                optimization_exceptions=json.loads((work / "optimization_exceptions.json").read_text()))
(work / "build.json").write_text(json.dumps(metadata, indent=2) + "\n")
PY
"$WORK/tsc-ts" --version
