// Objects the runtime allocates and links to a builtin prototype (iterators,
// generator objects, typed arrays): their prototypes, tags and iteration,
// with property additions to plain objects interleaved, whose caches must
// stay correct around them (docs/negative_cache_design.md, epoch churn).
interface Item { kind: number; extra?: number; tag?: string; }
function* gen(n: number): Generator<number> { for (let i = 0; i < n; i++) yield i; }
function main(): void {
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  const s = new Set<number>([3, 4]);
  const it = m.entries();
  console.log(Object.prototype.toString.call(it), Object.prototype.toString.call(s.values()));
  console.log(it[Symbol.iterator]() === it, typeof (it as any).next, [...m.keys()].join(","), [...s].join(","));
  const g = gen(3);
  console.log(Object.getPrototypeOf(Object.getPrototypeOf(g)) === Object.getPrototypeOf(Object.getPrototypeOf(gen(0))), [...g].join(","));
  // additions to fresh plain objects, interleaved with iterators and generators
  let sum = 0;
  const nodes: Item[] = [];
  for (let i = 0; i < 3000; i++) {
    const n: Item = { kind: i & 7 };
    if (i % 3 === 0) n.extra = i;
    for (const [k, v] of m) sum += v + k.length;
    for (const x of gen(2)) sum += x;
    if (i % 5 === 0) n.tag = "t" + (i & 3);
    nodes.push(n);
  }
  let extras = 0, tags = 0;
  for (const n of nodes) { if (n.extra !== undefined) extras += n.extra; if (n.tag !== undefined) tags++; }
  console.log(sum, extras, tags);
  // a typed array keeps its prototype and element behaviour
  const u = new Uint16Array(3); u[1] = 70000;
  console.log(Object.prototype.toString.call(u), u[1], u.length);
}
main();
