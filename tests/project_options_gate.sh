#!/usr/bin/env bash
# Project checking options, ambient declarations and resolution must reach the
# public driver without disabling the type-error gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"
cat > "$WORK/base.json" <<'JSON'
{"compilerOptions":{"strict":true,"useUnknownInCatchVariables":false,
"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2020",
"composite":true,"declaration":true,"declarationMap":true,
"emitDeclarationOnly":true,"outDir":"out","rootDir":"src"}}
JSON
cat > "$WORK/tsconfig.json" <<'JSON'
{"extends":"./base.json","include":["src/**/*"]}
JSON
cat > "$WORK/src/global.d.ts" <<'TS'
interface ProjectMessage { value: number }
TS
cat > "$WORK/src/dep.ts" <<'TS'
export const value = 42;
TS
cat > "$WORK/src/main.ts" <<'TS'
import { value } from "./dep.js";
const message: ProjectMessage = { value };
try { throw new Error("project"); }
catch (error) { console.log(error.message, message.value); }
TS
./garnet -p "$WORK" -o "$WORK/main.c" "$WORK/src/main.ts" >"$WORK/build.out" 2>"$WORK/build.err"
[[ "$("$WORK/main")" == "project 42" ]]
cat > "$WORK/src/bad.ts" <<'TS'
const value: number = "not a number";
console.log(value);
TS
if ./garnet -c --project "$WORK/tsconfig.json" -o "$WORK/bad.c" "$WORK/src/bad.ts" >"$WORK/bad.out" 2>"$WORK/bad.err"; then
  echo "[project-options] FAIL: project disabled the type-error gate"; exit 1
fi
grep -q 'Refusing to compile ill-typed input' "$WORK/bad.err"
[[ ! -f "$WORK/bad.c" ]]
if ./garnet -c -p "$WORK/missing.json" "$WORK/src/main.ts" >"$WORK/missing.out" 2>"$WORK/missing.err"; then
  echo "[project-options] FAIL: missing project accepted"; exit 1
fi
grep -q 'Cannot read file' "$WORK/missing.err"
echo "[project-options] PASS: inherited options, project declarations, native execution and diagnostic gates"
