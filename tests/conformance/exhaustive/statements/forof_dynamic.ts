// for..of over values whose static type does not settle the iteration
// protocol (any, unknown, unions, type parameters): arrays walk by index,
// strings by code points, Map / Set / generators / custom iterables through
// their iterators, live under mutation; a non-iterable throws a TypeError.
function* gen(n: number): Generator<number> { for (let i = 0; i < n; i++) yield i * 10; }
class Bag implements Iterable<string> {
  constructor(private items: string[]) {}
  *[Symbol.iterator](): Iterator<string> { for (const x of this.items) yield x.toUpperCase(); }
}
function sumAll<T extends Iterable<number>>(xs: T): number { let s = 0; for (const x of xs) s += x; return s; }
function viaUnion(xs: number[] | Set<number>): number { let s = 0; for (const x of xs) s += x; return s; }
function viaUnknown(v: unknown): string {
  const out: string[] = [];
  try { for (const x of v as any) out.push(String(x)); } catch (e) { out.push((e as Error).constructor.name); }
  return out.join(",");
}
function main(): void {
  const vals: any[] = [new Map([["a", 1], ["b", 2]]), new Set([3, 4]), gen(3), "x\u{1F600}y", [5, , 7], new Bag(["p", "q"]),
    { [Symbol.iterator]() { let i = 0; return { next: () => ({ done: i >= 2, value: "c" + i++ }) }; } }];
  for (const v of vals) console.log(viaUnknown(v));
  console.log(viaUnknown(42), viaUnknown(null), viaUnknown(undefined), viaUnknown({}));
  console.log(sumAll([1, 2, 3]), sumAll(new Set([4, 5])), sumAll(gen(4)), viaUnion([1, 2]), viaUnion(new Set([7, 8])));

  // live: a Map gaining entries, an array growing, a Set losing one
  const m: any = new Map([["k0", 0]]);
  const seen: string[] = [];
  for (const [k, v] of m) { seen.push(k + "=" + v); if (v < 3) m.set("k" + (v + 1), v + 1); }
  const arr: any = [1, 2];
  for (const x of arr) { seen.push("a" + x); if (x === 1) arr.push(3); }
  const st: any = new Set([1, 2, 3]);
  for (const x of st) { seen.push("s" + x); if (x === 1) st.delete(2); }
  console.log(seen.join(" "));

  // break / continue / labels / closures over the loop variable
  const fns: (() => string)[] = [];
  const it: any = new Set(["u", "v", "w", "z"]);
  outer: for (const x of it) {
    if (x === "v") continue;
    for (const y of gen(3) as any) { if (y === 10) continue outer; fns.push(() => x + y); }
    if (x === "w") break;
  }
  console.log(fns.map((f) => f()).join(","));

  // a long loop over an any-typed array at one site
  const big: any = [];
  for (let i = 0; i < 5000; i++) big.push(i);
  let total = 0;
  for (const x of big) total += x;
  console.log(total);
}
main();
