// Captured bindings that are never reassigned (parameters, constants, loop
// constants) travel by value into closures and directly called nested
// declarations; everything that is assigned anywhere stays shared.
function some<T>(xs: T[], f: (x: T) => boolean): boolean { for (const x of xs) if (f(x)) return true; return false; }
function map<T, U>(xs: T[], f: (x: T, i: number) => U): U[] { const out: U[] = []; for (let i = 0; i < xs.length; i++) out.push(f(xs[i], i)); return out; }
// 1. parameters captured by arrows passed to callbacks (no record needed)
function anyAbove(xs: number[], limit: number, tag: string): string { return some(xs, (x) => x > limit) ? tag + "+" : tag + "-"; }
// 2. a parameter captured by a hoisted declaration used as a value, and one called directly
function describe(prefix: string, xs: number[]): string {
  function label(x: number): string { return prefix + ":" + x; }
  function total(): number { let s = 0; for (const x of xs) s += x; return s; }
  return map(xs, label).join(",") + "|" + total();
}
// 3. constants captured after their declaration; a let assigned once at its declaration
function build(n: number): (() => number)[] {
  const base = n * 10;
  let scale = 2;
  const fs: (() => number)[] = [];
  for (let i = 0; i < 3; i++) fs.push(() => base + i * scale);
  return fs;
}
// 4. loop constants: each iteration's value, closures called after the loop
function perIteration(words: string[]): string[] {
  const fs: (() => string)[] = [];
  for (const w of words) fs.push(() => w.toUpperCase());
  for (const [i, w] of words.entries()) fs.push(() => i + w);
  return map(fs, (f) => f());
}
// 5. mutable bindings stay shared: every assignment form
function counters(): string {
  let a = 0; let b = 10; let c = 1; let d = 5; let e = 0; let f = 7; let g = 3;
  const bump = () => { a += 1; b = b - 1; c++; --d; [e, f] = [f, e]; g = g; };
  bump(); bump();
  let h = 0; for (h of [4, 5]) { } const readH = () => h;
  let k = 100; const setK = (v: number) => { k = v; }; setK(k + 1);
  return [a, b, c, d, e, f, g, readH(), k].join(",");
}
// 6. nested threading three levels deep, mixed with a mutable binding
function deep(p: number): number {
  let acc = 0;
  const l1 = (q: number) => { const r = p + q; const l2 = () => { const l3 = () => { acc += r; return r * 2; }; return l3(); }; return l2(); };
  return l1(1) + l1(2) + acc;
}
// 7. a default parameter captured by a hoisted declaration created after the default runs
function withDefault(x: number, y = x + 1): number { function f(): number { return x * 100 + y; } return f(); }
// 8. generators and async functions capturing parameters by value
function* gen(start: number, step: number): Generator<number> { const next = (i: number) => start + i * step; for (let i = 0; i < 3; i++) yield next(i); }
async function later(v: string): Promise<string> { const f = () => v + "!"; await Promise.resolve(); return f(); }
// 9. an object-literal method capturing parameters; an escaping closure holding an object
function makeHolder(obj: { n: number }, k: number) {
  const holder = { get(): number { return obj.n + k; } };
  return () => holder.get() + obj.n;
}
// 10. a closure created before the constant's declaration keeps the cell (TDZ-safe ordering)
function lateConst(): number { const g = () => x; const x = 41; return g() + 1; }
function main(): void {
  console.log(anyAbove([1, 5, 9], 7, "a"), anyAbove([1, 2], 7, "b"));
  console.log(describe("p", [1, 2, 3]));
  console.log(build(4).map((f) => f()).join(","));
  console.log(perIteration(["x", "y"]).join(","));
  console.log(counters());
  console.log(deep(10));
  console.log(withDefault(2), withDefault(2, 9));
  console.log([...gen(5, 3)].join(","));
  later("z").then((s) => console.log(s));
  const o = { n: 1 }; const h = makeHolder(o, 20); o.n = 2; console.log(h());
  console.log(lateConst());
  // GC pressure with captured object values
  const keep: (() => number)[] = [];
  for (let i = 0; i < 20000; i++) { const payload = { v: i, s: "s" + (i & 7) }; keep.push(() => payload.v + payload.s.length); if ((i & 1023) === 0) { let junk = 0; for (let j = 0; j < 5000; j++) junk += [j, { j }].length; if (junk < 0) console.log(junk); } }
  let sum = 0; for (const f of keep) sum += f(); console.log(sum);
}
main();
