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
# open (slice 2): a method value leaving a call position, a delete that can reach a class field
check open   'const f = new C().m; sink(f);'
check open   'const o: any = {}; o.m = new C().m; sink(o);'
check open   'const a: any = new C(); sink(a.m);'
check open   'const c = new C(); const k: string = "m"; sink(c[k as keyof C]);'
check open   'const { m } = new C(); sink(m);'
check open   'sink(Object.getOwnPropertyDescriptor(C.prototype, "m"));'
# slice 3: a borrow of a function value opens the program only when a method is read as a value somewhere
check closed 'function run(cb: () => number, t: object): number { return cb.call(t); } sink(run(() => 1, {}));'
check closed 'const o = { m: () => 1 }; sink(o.m.apply(null, []));'
check closed 'function later(cb: (x: number) => void): void { cb.bind(null)(1); } later((x) => sink(x));'
check open   'function run(cb: () => number, t: object): number { return cb.call(t); } const f = new C().m; sink(run(f, {}));'
check open   'const d = Object.getOwnPropertyDescriptor(new C(), "m"); sink(d);'
check open   'const v = Reflect.get(new C(), "m"); sink(v);'
# a static method is never a struct method (it lives on the class value): borrowing one is closed
check closed 'function run(cb: () => number): number { return cb.call({}); } class S { static sm(): number { return 1; } } sink(run(S.sm));'
check closed 'class S { static sm(): number { return 1; } } sink(S.sm.call({}));'
check closed 'class L { v = 1; m(): number { return this.v; } } const l = new L(); sink(l.m.bind(l)());'
check open   'class D { g = 2; } const c = new C(); sink(c.m.bind(new D()));'
check open   'const c = new C(); delete (c as any).f; sink(c);'
check open   'const c: Partial<C> = new C(); delete c.f; sink(c);'
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
check closed 'const r: Record<string, number> = { a: 1 }; delete r.a; const xs = [1, 2]; delete xs[0]; sink(r); sink(xs);'
check closed 'class E2 extends C { g = 1; } const e = new E2(); sink(C.prototype.m.call(e)); sink(e.m.bind(e)());'
check closed 'const c = new C(); sink(typeof c.m);'
echo "[closed] $n programs, $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
