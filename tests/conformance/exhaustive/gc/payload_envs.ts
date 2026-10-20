// Closure environments in the payload heap (docs/gc_v2_design.md §6.1,
// slice G2a): a heap closure's captured-environment buffer is released,
// without a visit, when a collection does not mark it through its closure.
// Closures that stay alive keep their captured values across many
// collections (young, promoted, created inside long-lived objects), while the
// buffers of dead closures are recycled for new ones of the same size.
function makeAdder(a: number, b: string): (x: number) => string {
  const c = a * 2;
  return (x: number) => b + ":" + (a + c + x);
}
function makeCounter(start: number): { inc: () => number; get: () => number } {
  let n = start;
  return { inc: () => ++n, get: () => n };
}
function churn(rounds: number): number {
  let acc = 0;
  for (let i = 0; i < rounds; i++) {
    const k = i & 7;
    const f1 = (x: number) => x + k;
    const f2 = (x: number) => x * k + i;
    const big = makeAdder(i, "t" + k);
    acc += f1(1) + f2(2) + big(3).length;
  }
  return acc;
}
const keep: ((x: number) => string)[] = [];
const counters: { inc: () => number; get: () => number }[] = [];
let total = 0;
for (let round = 0; round < 30; round++) {
  keep.push(makeAdder(round, "r" + round));
  counters.push(makeCounter(round * 10));
  total += churn(300);
  if (round % 5 === 4) keep.splice(0, 2);
  for (const c of counters) c.inc();
}
let check = 0;
for (let i = 0; i < keep.length; i++) check += keep[i](i).length + Number(keep[i](i).split(":")[1]);
for (const c of counters) check += c.get();
console.log(total, keep.length, counters.length, check);

// environments of closures stored in a long-lived object
class Registry {
  handlers: (() => number)[] = [];
  add(v: number, w: string): void { this.handlers.push(() => v * 3 + w.length); }
}
const reg = new Registry();
for (let i = 0; i < 2000; i++) { reg.add(i, "w" + (i % 13)); if (i % 100 === 0) churn(50); }
let s = 0;
for (const h of reg.handlers) s += h();
console.log(s);

// nested closures: an inner closure keeps the outer environment's values
function outer(n: number): () => () => number {
  const base = n * 7;
  return () => {
    const mid = base + 1;
    return () => mid + n;
  };
}
const inners: (() => number)[] = [];
for (let i = 0; i < 500; i++) { inners.push(outer(i)()); churn(5); }
let t = 0;
for (const f of inners) t += f();
console.log(t);
