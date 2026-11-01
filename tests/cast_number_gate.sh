#!/bin/bash
# A cast to `number` of a value of another type that flows on into a number-typed slot is a TypeError, in typed mode:
# the slot is unboxed, the value would turn into NaN silently (docs/cast_to_number_design.md). V8 does not check casts,
# so the conformance oracle cannot show this; used in place such a cast agrees with V8 (types/cast_lies).
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); fail=0
cat > "$tmp/c.ts" <<'TS'
const t = (f: () => unknown) => { try { console.log(f()); } catch (e: any) { console.log(e.name + ": " + e.message); } };
t(() => { function add(a: number, b: number) { return a + b; } return add("1" as unknown as number, 2); });
t(() => { class P { x = 1; } const p = new P(); p.x = "str" as unknown as number; return p.x; });
t(() => { const n = "x" as unknown as number; return n; });
t(() => { function r(): number { return {} as unknown as number; } return r(); });
t(() => { const u: unknown = 5; const n = u as number; return n + 1; });
t(() => { let n = undefined as unknown as number; n = 7; return n; });
interface Config { port: number; name: string; tags: string[] }
t(() => { const c = JSON.parse('{"port":"8080"}') as Config; const p: number = c.port; return p; });
t(() => { const c = JSON.parse("{}") as Config; const f = (n: number) => n; return f(c.port); });
t(() => { const c: Config = JSON.parse('{"port":"x"}'); return c.port + 1; });
t(() => (JSON.parse('[1,"x"]') as number[]).length);
TS
TSAOT_CC="${TSAOT_CC:-cc -O1}" ./garnet -o "$tmp/c.c" "$tmp/c.ts" > "$tmp/out" 2>&1 || { echo "[cast-number] FAIL: compile"; tail -3 "$tmp/out"; exit 1; }
got=$("$tmp/c")
want=$(cat <<'WANT'
TypeError: A value of type string was cast to number
TypeError: A value of type string was cast to number
TypeError: A value of type string was cast to number
TypeError: A value of type object was cast to number
6
7
TypeError: 'port' is typed number and holds a value of type string
TypeError: 'port' is typed number and holds a value of type undefined
TypeError: A value of type string was cast to number
TypeError: 'element' is typed number and holds a value of type string
WANT
)
if [ "$got" == "$want" ]; then echo "[cast-number] PASS: a lying cast into a number slot throws"; else echo "[cast-number] FAIL:"; echo "$got"; fail=1; fi
exit $fail
