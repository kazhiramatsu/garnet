#!/usr/bin/env bash
# The exporter's closed-receivers verdict (docs/closed_receivers_design.md):
# each program below either reaches a runtime point that raises g_typed_slow
# (open: its typed accesses keep the test) or provably reaches none (closed).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PRELUDE='class C { f = 1; m(): number { return this.f; } }
class Empty { m(): number { return 0; } }
declare function sink(x: unknown): void;'
fail=0; n=0
check() { # want body
  local want="$1" body="$2" got
  n=$((n+1))
  printf '%s\nfunction main(): void {\n%s\n}\nmain();\n' "$PRELUDE" "$body" > "$T/p$n.ts"
  got=$(TSAOT_CLOSED_LOG=1 node "$ROOT/exporter/exporter.js" "$T/p$n.ts" "$T/p.json" "$T/l.json" 2>&1 |
        sed -En 's/^\[closed\] receivers (closed|open).*/\1/p' | head -1)
  if [[ "$got" != "$want" ]]; then
    echo "[closed] FAIL want=$want got=${got:-none}: $body"; fail=1
  fi
}
# open: a Proxy, a relink behind a prototype, a borrowed method, and their dynamic routes
check open   'const p = new Proxy(new C(), {}); sink(p);'
check open   'const P = (globalThis as any).Proxy; sink(P);'
check open   'const o = {}; Object.setPrototypeOf(o, C.prototype); sink(o);'
check open   'const sp = Object.setPrototypeOf; sink(sp);'
check open   'const o = Object["setPrototypeOf"]({}, C.prototype); sink(o);'
check open   'const o = Reflect.setPrototypeOf({}, C.prototype); sink(o);'
check open   'sink(Object.create(C.prototype));'
check open   'const O = Object; sink(O);'
check open   'const o: any = {}; o.__proto__ = C.prototype; sink(o);'
check open   'const o = { __proto__: C.prototype }; sink(o);'
check open   'sink(C.prototype.m.call({ f: 2 }));'
check open   'const c = new C(); sink(c.m.apply({}, []));'
check open   'const c = new C(); const f = c.m.bind({}); sink(f());'
check open   'sink(Reflect.apply(C.prototype.m, {}, []));'
check open   'const f: any = new C().m; sink(f.call({}));'
check open   'const { call } = Function.prototype; sink(call);'
check open   'const a: any = Object; const k: string = "create"; sink(a[k]);'
check open   'const g = new Function("return 1"); sink(g);'
check open   'const c = new C(); [1, 2].forEach(c.m, {}); sink(c);'
check open   'const e = new Empty(); sink(e.m.call(new Empty()));'
check open   'interface Callable { call(t: unknown): number } const k: Callable = C.prototype.m; sink(k.call({}));'
# closed: no route to the raise points
check closed 'const c = new C(); sink(c.m() + c.f);'
check closed 'sink(Object.create(null)); sink(Object.setPrototypeOf({ a: 1 }, null));'
check closed 'const c = new C(); const f = c.m.bind(c); sink(f());'
check closed 'sink(Math.max.apply(null, [1, 2])); sink(Object.prototype.hasOwnProperty.call({ a: 1 }, "a"));'
check closed 'const c = new C(); [1, 2].forEach(function (this: C, x: number) { sink(x); }, c);'
check closed 'const c = new C(); [1, 2].forEach((x) => sink(x + c.f));'
check closed 'const c = new C(); sink(C.prototype.m.call(c));'
check closed 'const u = { call: new C() }; sink(u.call.f);'
check closed 'const o: Record<string, number> = { a: 1 }; const k: string = "a"; sink(o[k]);'
check closed 'sink(new C() instanceof C); sink(typeof Object.keys);'
echo "[closed] $n programs, $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
