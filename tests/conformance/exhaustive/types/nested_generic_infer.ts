function mapArr<T, U>(arr: T[], f: (t: T) => U): U[] { return arr.map(f); }
function flatMap<T, U>(arr: T[], f: (t: T) => U[]): U[] { const out: U[] = []; for (const x of arr) for (const y of f(x)) out.push(y); return out; }
function zip<A, B>(a: A[], b: B[]): [A, B][] { const out: [A, B][] = []; for (let i = 0; i < Math.min(a.length, b.length); i++) out.push([a[i], b[i]]); return out; }
function groupBy<T, K extends string | number>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
  return m;
}
function main(): void {
  console.log(mapArr([1, 2, 3], x => x * x).join(","));               // 1,4,9
  console.log(flatMap([1, 2], x => [x, x * 10]).join(","));           // 1,10,2,20
  console.log(zip([1, 2], ["a", "b"]).map(p => p[0] + p[1]).join(",")); // 1a,2b
  const g = groupBy([1, 2, 3, 4, 5], n => (n % 2 === 0 ? "even" : "odd"));
  console.log(g.get("odd")!.join(","), g.get("even")!.join(","));     // 1,3,5 2,4
  console.log(mapArr(mapArr([1, 2], x => x + 1), x => "v" + x).join(",")); // v2,v3
}
main();
