// A nested declaration used as a value gets its closure on first use (per
// activation), keeping identity; direct calls need no closure at all.
function apply(f: (x: number) => number, x: number): number { return f(x); }
function pick(flag: boolean, a: (x: number) => number, b: (x: number) => number): (x: number) => number { return flag ? a : b; }
const seen = new Set<unknown>();
function owner(n: number, useValue: boolean): string {
  let hits = 0;
  function inc(x: number): number { hits++; return x + n; }
  function dbl(x: number): number { return x * 2 + n; }
  // direct calls only: no closure is ever created for these calls
  let s = inc(1) + dbl(2);
  if (useValue) {
    // the value is created here, once per activation, and identical afterwards
    const f1 = inc; const f2 = inc;
    s += apply(f1, 10) + apply(f2, 20) + apply(inc, 30);
    seen.add(inc); seen.add(f1); seen.add(dbl);
    s += pick(n > 1, inc, dbl)(1);
    // a nested closure reads the same closure value
    const viaNested = () => apply(inc, 100) + (inc === f1 ? 1 : 0);
    s += viaNested();
  }
  return n + ":" + s + ":" + hits;
}
// a use before the declaration's text (hoisting) and recursion through the value
function early(k: number): number {
  const g = rec;
  function rec(i: number): number { return i <= 0 ? k : 1 + (g as (i: number) => number)(i - 1); }
  return g(3) + apply(rec, 2);
}
// identity across activations differs (a fresh closure per activation)
function fresh(): () => number { function h(): number { return 7; } return h; }
// generator owner using a declaration as a value on one branch
function* genOwner(flag: boolean): Generator<number> {
  function tag(x: number): number { return x * 10; }
  yield tag(1);
  if (flag) yield apply(tag, 2); else yield 0;
}
// a declaration capturing a loop constant, used as a value in the loop
function loops(xs: number[]): number[] {
  const out: number[] = [];
  for (const x of xs) { function addX(y: number): number { return x + y; } out.push(apply(addX, 1)); if (x > 1) out.push(apply(addX, 2)); }
  return out;
}
// a sibling lowered first reads a LATER declaration's value (the compiler's
// `tryParse(parseJSDocLinkPrefix)`): the lazy storage must exist before any body
function siblings(k: number): number {
  function useLater(): number { return apply(later, 1); }
  function later(x: number): number { return x + k; }
  return useLater() + apply(later, 2);
}
async function asyncOwner(v: number): Promise<number> { function twice(x: number): number { return x * 2; } await Promise.resolve(); return apply(twice, v); }
function main(): void {
  console.log(owner(1, false), owner(2, true), owner(3, true), seen.size);
  console.log(early(5), fresh() === fresh(), fresh()());
  console.log([...genOwner(true)].join(","), [...genOwner(false)].join(","));
  console.log(loops([1, 2, 3]).join(","), siblings(10));
  asyncOwner(21).then((r) => console.log(r));
  // many activations that never use the value: no closures created
  let acc = 0; for (let i = 0; i < 200000; i++) acc += owner(i, false).length; console.log(acc);
  // identity table keyed by the lazily created closure
  const table = new Map<unknown, number>();
  function keyed(i: number): number { function key(): number { return i; } if (!table.has(key)) table.set(key, i); return table.get(key)! + (key === key ? 0 : 1); }
  let t = 0; for (let i = 0; i < 5; i++) t += keyed(i); console.log(t, table.size);
}
main();
