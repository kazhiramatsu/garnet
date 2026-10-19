// Non-escaping closures live on the C stack: callbacks handed to direct
// callees that only call them, closures called locally, conditional and
// nested closures, recursion through a local function, metadata reads,
// call/apply, try/catch, and an environment that holds young objects while
// the body allocates enough to force collections (the environment slots must
// be forwarded by the moving collector).
interface Item { id: number; tags: string[]; }
function each(items: Item[], cb: (it: Item, i: number) => void): void { for (let i = 0; i < items.length; i++) cb(items[i], i); }
function count(items: Item[], pred: (it: Item) => boolean): number { let n = 0; for (const it of items) if (pred(it)) n++; return n; }
function twice(f: () => number): number { return f() + f(); }
function apply1<T>(f: (x: number) => T, x: number): T { return f(x); }
function makeItems(n: number, seed: number): Item[] { const out: Item[] = []; for (let i = 0; i < n; i++) out.push({ id: seed + i, tags: ["t" + i, "u" + (i % 3)] }); return out; }
function sumIds(items: Item[], offset: number): number {
  let total = 0;
  each(items, (it, i) => { total += it.id + offset + i; });
  return total;
}
function countTagged(items: Item[], tag: string): number { return count(items, (it) => it.tags.indexOf(tag) >= 0); }
function localCalls(base: number): number {
  const add = (x: number) => base + x;
  const mul = (x: number) => base * x;
  let s = 0;
  for (let i = 0; i < 5; i++) s += add(i) + mul(i);
  return s + twice(() => base);
}
function conditional(flag: boolean, k: number): number {
  const f = flag ? (x: number) => x + k : (x: number) => x * k;
  return apply1(f, 7) + apply1((x) => x - k, 7);
}
function nested(n: number): number {
  const outer = (x: number) => { const inner = (y: number) => x + y + n; return inner(1) + inner(2); };
  return twice(() => outer(10));
}
function recursion(n: number): number {
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  return fact(n);
}
function meta(): string {
  const named = (a: number, b: number) => a + b;
  return named.name + "/" + named.length + "/" + named.call(null, 1, 2) + "/" + named.apply(null, [3, 4]) + "/" + typeof named;
}
function withTry(items: Item[]): number {
  let n = 0;
  try { each(items, (it) => { if (it.id === 3) throw new Error("three"); n++; }); } catch (e) { n += 100; }
  return n;
}
function gcPressure(): number {
  // the environment holds young objects; the loop allocates enough to move them
  const young = makeItems(3, 1000);
  const probe = (k: number) => young[k % 3].id + young[k % 3].tags.length;
  let acc = 0;
  for (let i = 0; i < 200000; i++) { const tmp = { v: i, w: [i] }; acc = (acc + tmp.v + tmp.w.length + probe(i)) % 1000003; }
  return acc + young[0].id;
}
function main(): void {
  const items = makeItems(5, 10);
  console.log(sumIds(items, 1), countTagged(items, "u1"), localCalls(3), conditional(true, 2), conditional(false, 2), nested(4), recursion(6));
  console.log(meta(), withTry(items), withTry(makeItems(2, 3)), gcPressure());
  for (let round = 0; round < 3; round++) console.log(sumIds(makeItems(4, round), round));
}
main();
