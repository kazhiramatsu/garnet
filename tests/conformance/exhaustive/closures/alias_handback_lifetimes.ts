// Lifetime attacks on the escape analysis, the other direction from
// param_contents_lifetimes: a callee hands the CALLER's own object back to it
// (docs/escape_param_contents_design.md, x53). The caller allocates a class
// instance (a stack candidate), passes it inside a holder, and gets an alias
// back through a return two loads deep, an element, a store into another
// parameter, into the same parameter, into `this`, a fresh object or array
// wrapping it, a recursion nest's compact summary (a fresh object two deep),
// or a closure's return / a closure storing into its declared parameter. Every
// alias is kept in a module array and read after the frames are gone, after a
// recursion that reuses the stack and enough allocation to force collections.
class B { v: number; w = 2; constructor(v: number) { this.v = v; } }
class A { b: B; constructor(b: B) { this.b = b; } }
interface HA { a: A }
interface HB { a: B }
interface Q { x: B | null }
const keep: B[] = [];
const sink: Q = { x: null };
function deepRet(p: HA): B { return p.a.b; }
function elemRet(p: A[]): B { return p[0].b; }
function oneRet(p: HB): B { return p.a; }
function intoParam(p: HB, q: Q): void { q.x = p.a; }
function deepIntoParam(p: HA, q: Q): void { q.x = p.a.b; }
function selfLink(p: { a: B; c: B | null }): void { p.c = p.a; }
function wrapRet(p: HB): { v: B } { return { v: p.a }; }
function arrRet(p: HB): B[] { return [p.a]; }
class M { x: B | null = null; take(p: HB): void { this.x = p.a; } }
function nest(p: B, n: number): { v: { w: B } } { return n > 0 ? nest(p, n - 1) : { v: { w: p } }; }
function ping(p: B, n: number): { v: { w: B } } { return n > 0 ? pong(p, n - 1) : { v: { w: p } }; }
function pong(p: B, n: number): { v: { w: B } } { return ping(p, n); }
function callIt(g: () => { v: B }): void { keep.push(g().v); }
function callArr(g: () => B[]): void { keep.push(g()[0]); }
function callNested(g: () => { v: { w: B } }): void { keep.push(g().v.w); }
function callDeep(g: () => B): void { keep.push(g()); }
function invokeWith(f: (q: Q) => void): void { f(sink); }
function invokeLocal(f: (q: Q) => void, q: Q): void { f(q); }
const cases: ((i: number) => void)[] = [
  i => { const b = new B(i); keep.push(deepRet({ a: new A(b) })); },
  i => { const b = new B(i); keep.push(elemRet([new A(b)])); },
  i => { const b = new B(i); keep.push(oneRet({ a: b })); },
  i => { const b = new B(i); const q: Q = { x: null }; intoParam({ a: b }, q); keep.push(q.x!); },
  i => { const b = new B(i); const q: Q = { x: null }; deepIntoParam({ a: new A(b) }, q); keep.push(q.x!); },
  i => { const b = new B(i); const p = { a: b, c: null as B | null }; selfLink(p); keep.push(p.c!); },
  i => { const b = new B(i); keep.push(wrapRet({ a: b }).v); },
  i => { const b = new B(i); keep.push(arrRet({ a: b })[0]); },
  i => { const b = new B(i); const m = new M(); m.take({ a: b }); keep.push(m.x!); },
  i => { const b = new B(i); keep.push(nest(b, 2).v.w); },
  i => { const b = new B(i); keep.push(ping(b, 3).v.w); },
  i => { const b = new B(i); const f = () => ({ v: b }); keep.push(f().v); },
  i => { const b = new B(i); callIt(() => ({ v: b })); },
  i => { const b = new B(i); callArr(() => [b]); },
  i => { let b = new B(i); if (i < 0) b = new B(0); callIt(() => ({ v: b })); },
  i => { const b = new B(i); callNested(() => ({ v: { w: b } })); },
  i => { const b = new B(i); const mk = () => () => ({ v: b }); callIt(mk()); },
  i => { const b = new B(i); const o = { h: new A(b) }; callDeep(() => o.h.b); },
  i => { const b = new B(i); invokeWith(q => { q.x = b; }); keep.push(sink.x!); },
  i => { const b = new B(i); const q: Q = { x: null }; invokeLocal(qq => { qq.x = b; }, q); keep.push(q.x!); },
];
function viaReturn(i: number): B { const b = new B(i); return deepRet({ a: new A(b) }); }
function scribble(n: number): number {
  const x = new B(n * 1000); const y = new B(n * 2000); const z = new B(n * 3000);
  return x.v + y.v + z.v + (n > 0 ? scribble(n - 1) : 0);
}
// Heap allocations for real (a dropped `new B(i)` would be scalar-replaced).
const junk: B[][] = [[]];
function churn(): number {
  let n = 0;
  for (let i = 0; i < 300000; i++) { const arr = junk[0]; arr.push(new B(i)); if (arr.length > 64) { junk[0] = []; n++; } }
  return n;
}
function main(): void {
  for (let round = 0; round < 3; round++) {
    for (let j = 0; j < cases.length; j++) cases[j](round * 100 + j + 1);
    keep.push(viaReturn(round * 100 + 99));
    scribble(8);
    churn();
  }
  let sum = 0;
  for (const k of keep) sum += k.v * 10 + k.w;
  console.log(keep.length, sum, keep.slice(0, cases.length + 1).map(k => k.v + ":" + k.w).join(","));
}
main();
