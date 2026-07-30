#!/usr/bin/env bash
# Legal TypeScript syntax that tsaot cannot execute yet must fail loudly.
# Every fixture is first checked by tsc, then required to produce UNSUPPORTED.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/tests/conformance/rejects"
TSC="$ROOT/exporter/node_modules/.bin/tsc"
EXPORTER="$ROOT/exporter/exporter.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -f "$EXPORTER" ]] || (
  cd "$ROOT/exporter" &&
  ./node_modules/.bin/tsc exporter.ts class_extract.ts --module commonjs \
    --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop
) || exit 1

pass=0
fail=0
while IFS= read -r file; do
  name="$(basename "$file")"
  name="${name%.tsx}"
  name="${name%.ts}"
  module=esnext
  case "$name" in
    import_equals|export_equals) module=commonjs ;;
  esac

  if ! "$TSC" --noEmit --strict --target es2022 --module "$module" \
      --moduleResolution node --lib es2023,dom,esnext.disposable,decorators \
      --jsx preserve --skipLibCheck "$file" >"$WORK/$name.tsc.out" 2>&1; then
    echo "[legal-syntax-reject] FAIL $name: fixture is not legal TypeScript"
    head -4 "$WORK/$name.tsc.out"
    fail=$((fail+1))
    continue
  fi

  if node "$EXPORTER" "$file" "$WORK/$name.json" "$WORK/$name.labels.json" \
      >"$WORK/$name.out" 2>"$WORK/$name.err"; then
    echo "[legal-syntax-reject] FAIL $name: exporter accepted unsupported syntax"
    fail=$((fail+1))
  elif ! grep -qi "UNSUPPORTED" "$WORK/$name.err" "$WORK/$name.out"; then
    echo "[legal-syntax-reject] FAIL $name: rejection was not an UNSUPPORTED diagnostic"
    head -4 "$WORK/$name.err"
    fail=$((fail+1))
  else
    echo "[legal-syntax-reject] PASS $name"
    pass=$((pass+1))
  fi
done < <(find "$DIR" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' \) | sort)

echo "[legal-syntax-reject] PASS=$pass FAIL=$fail"
(( fail == 0 ))
