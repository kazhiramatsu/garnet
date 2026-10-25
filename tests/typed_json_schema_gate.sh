#!/usr/bin/env bash
# garnet:json's schema derivation (docs/typed_json_design.md): the exporter compiles
# the type argument of `parse<T>` to the schema string the module parses. Each probe's
# derived schema must match, and a type JSON cannot carry must be rejected with a
# message naming the part.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0; n=0
export_probe() { # declarations type-expression -> the exporter's stderr+stdout (probe n)
  printf 'import { parse } from "garnet:json";\n%s\nfunction main(): void { const v = parse<%s>("0"); console.log(typeof v); }\nmain();\n' "$1" "$2" > "$T/p$n.ts"
  TSAOT_TYPED_JSON_LOG=1 node "$ROOT/exporter/exporter.js" "$T/p$n.ts" "$T/p.json" "$T/l.json" 2>&1
}
derive() { # want-schema declarations type-expression
  local want="$1" got
  n=$((n+1))
  got=$(export_probe "$2" "$3" | sed -En 's/^\[typed-json\] .* -> //p' | head -1)
  if [[ "$got" != "$want" ]]; then echo "[typed-json] FAIL $3: want $want got ${got:-none}"; fail=1; fi
}
reject() { # part declarations type-expression
  local got
  n=$((n+1))
  got=$(export_probe "$2" "$3" | grep -o "typed JSON cannot represent .*" | head -1)
  if [[ "$got" != "typed JSON cannot represent $1 in "* ]]; then echo "[typed-json] FAIL $3: want reject of '$1' got ${got:-none}"; fail=1; fi
}
derive '{"s":"n"}' '' 'number'
derive '{"s":"*"}' '' 'unknown'
derive '{"s":"*"}' '' 'any'
derive '{"s":{"k":"o","p":[["id","n",0],["name","s",0],["tags",{"k":"a","e":"s"},1],["score",{"k":"u","m":["z","n"]},0]]}}' \
  'type User = { id: number; name: string; tags?: string[]; score: number | null };' 'User'
derive '{"s":{"k":"u","m":["z","b"]}}' '' 'boolean | null'
derive '{"s":{"k":"t","e":["n","s"]}}' '' '[number, string]'
derive '{"s":{"k":"r","e":"n"}}' '' 'Record<string, number>'
derive '{"s":{"k":"a","e":"s"}}' '' 'readonly string[]'
derive '{"d":{"Tree":{"k":"o","p":[["v","n",0],["kids",{"k":"a","e":{"k":"ref","n":"Tree"}},0]]}},"s":{"k":"ref","n":"Tree"}}' \
  'type Tree = { v: number; kids: Tree[] };' 'Tree'
derive '{"d":{"A":{"k":"o","p":[["b",{"k":"o","p":[["a",{"k":"ref","n":"A"},1],["n","n",0]]},1]]}},"s":{"k":"ref","n":"A"}}' \
  'type A = { b?: B }; type B = { a?: A; n: number };' 'A'
derive '{"s":{"k":"u","m":[{"k":"l","v":"red"},{"k":"l","v":"blue"}]}}' 'enum Color { Red = "red", Blue = "blue" }' 'Color'
derive '{"s":{"k":"u","m":[{"k":"l","v":0},{"k":"l","v":1}]}}' 'enum Level { Low, High }' 'Level'
derive '{"s":{"k":"o","p":[["a","n",0],["b","s",0]]}}' '' '{ a: number } & { b: string }'
derive '{"s":{"k":"o","p":[["x","n",1]]}}' '' '{ x: number | undefined }'
reject 'a method (m)' 'interface I { m(): void }' 'I'
reject 'a class (C)' 'class C { x = 1 }' 'C'
reject 'a method (toString)' '' 'Date'
reject 'a method (clear)' '' 'Map<string, number>'
reject 'a function type' '' '() => void'
reject 'a function type' '' '{ f: (x: number) => number }'
reject 'a tuple with optional or rest elements' '' '[number, string?]'
reject 'an index signature beside named properties' '' '{ [k: string]: number; a: number }'
reject 'symbol' '' 'symbol'
reject 'bigint' '' 'bigint'
# a module-scope const with a literal initializer reads as the constant (the IR carries no cell read)
n=$((n+1))
printf 'const CH_QUOTE = 34;\nconst NAME = "q";\nfunction main(): void { let s = 0; for (let i = 0; i < 3; i++) s += CH_QUOTE; console.log(s, NAME); }\nmain();\n' > "$T/p$n.ts"
if node "$ROOT/exporter/exporter.js" "$T/p$n.ts" "$T/c.json" "$T/cl.json" >/dev/null 2>&1; then
  if ! python3 - "$T/c.json" <<'PY'
import json, sys
def walk(x, out):
    if isinstance(x, dict):
        if x.get("kind") == "Const" and isinstance(x.get("value"), dict): out.add((x["value"].get("kind"), x["value"].get("value")))
        for v in x.values(): walk(v, out)
    elif isinstance(x, list):
        for v in x: walk(v, out)
consts = set(); walk(json.load(open(sys.argv[1])), consts)
sys.exit(0 if ("Num", 34) in consts and ("Str", "q") in consts else 1)
PY
  then echo "[typed-json] FAIL module const fold: the IR has no Const 34 / \"q\""; fail=1; fi
else echo "[typed-json] FAIL module const fold: export failed"; fail=1; fi
if [[ $fail -eq 0 ]]; then echo "[typed-json] PASS ($n probes)"; else echo "[typed-json] FAIL"; exit 1; fi
