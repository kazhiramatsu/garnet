#!/usr/bin/env bash
# Walks microsoft/TypeScript tests/cases/conformance/ and emits the list
# of tests usable by tsaot's conformance harness, in `name<TAB>path` format.
#
# Usage:
#   list_tsc_tests.sh <ts-root> <mode>
#
# mode = runtime   -> single-file, has console.log, no @noEmit, <=200 lines,
#                     not in unsupported subdirs. Compared against V8 stdout.
# mode = loud      -> single-file, no console.log requirement, in a curated
#                     subdir set, <=200 lines. Acceptance test:
#                     OK | UNSUPPORTED is a pass; ERROR (crash) is a FAIL.
#
# The output is written to stdout. Pipe it into the harness's list input.

set -uo pipefail

TS_ROOT="${1:?usage: list_tsc_tests.sh <ts-root> <mode>}"
MODE="${2:?usage: list_tsc_tests.sh <ts-root> <mode>}"
ROOT="$TS_ROOT/tests/cases/conformance"
[[ -d "$ROOT" ]] || { echo "no conformance dir at $ROOT" >&2; exit 1; }

# Subdirs excluded for ALL modes (declaration emit, module resolution, decorators,
# JSDoc-only tests, parser-specific cases, etc.).
SKIP_DIRS=(
  declarationEmit emitter externalModules moduleResolution references
  jsx jsdoc salsa parser scanner directives ambient
  importAttributes importAssertion importDefer dynamicImport
  decorators esDecorators internalModules typings
)

case "$MODE" in
  runtime)
    # Pilot Class A: runtime-output single-file tests.
    INCLUDE_DIRS=(. expressions statements classes controlFlow types
                  functions interfaces es5 es6 es2016 es2017 es2018 es2019
                  es2020 generators enums constEnums Symbols additionalChecks)
    ;;
  loud)
    # Pilot Class B: lowering acceptance over expressions + statements.
    INCLUDE_DIRS=(expressions statements)
    ;;
  *)
    echo "unknown mode '$MODE' (use 'runtime' or 'loud')" >&2; exit 2 ;;
esac

# Build the find expression as an OR of include dirs.
find_args=()
for d in "${INCLUDE_DIRS[@]}"; do
  if [[ "$d" == "." ]]; then
    # Files at the top level of conformance/ — none currently, but be liberal.
    find_args+=(-or -path "$ROOT/*.ts" -not -path "$ROOT/*/*")
  else
    find_args+=(-or -path "$ROOT/$d/*")
  fi
done
# Strip the leading -or
unset 'find_args[0]'

# Enumerate candidate files (mapfile is bash 4+ only; portable equivalent).
cands=()
while IFS= read -r _line; do cands+=("$_line"); done < <(find "$ROOT" \( "${find_args[@]}" \) -name '*.ts' 2>/dev/null | sort)

# Filter
for f in "${cands[@]}"; do
  # Skip .d.ts (declaration files)
  [[ "$f" == *.d.ts ]] && continue

  # Skip files in unsupported subdirs (e.g. expressions/jsx/...)
  skip=0
  for sd in "${SKIP_DIRS[@]}"; do
    [[ "$f" == *"/$sd/"* ]] && { skip=1; break; }
  done
  (( skip )) && continue

  # Size cap: <= 200 lines
  lines=$(wc -l < "$f")
  (( lines > 200 )) && continue

  # Skip multi-file tests (use // @filename:)
  grep -q '^//[[:space:]]*@filename:' "$f" && continue

  # Mode-specific extra rules
  case "$MODE" in
    runtime)
      # Must have console.log
      grep -q 'console\.log' "$f" || continue
      # Must not be @noEmit
      grep -qE '^//[[:space:]]*@noEmit:[[:space:]]*true' "$f" && continue
      ;;
  esac

  # Build slug: relative path with / -> __
  rel="${f#$ROOT/}"
  slug="tscconf__${rel%.ts}"
  slug="${slug//\//__}"
  # Sanitize: only alnum + _
  slug="${slug//[^a-zA-Z0-9_]/_}"
  printf '%s\t%s\n' "$slug" "$f"
done
