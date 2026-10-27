// An array iterator cast to IterableIterator and wrapped (vue's reactive array iteration: the original
// next saved as _next, a next that maps the value installed as an own property) drives for..of, spread
// and a manual loop; a generator typed as an IterableIterator still steps as a generator.
function* g(): Generator<number> { yield 1; yield 2; }
function wrap(arr: number[]): IterableIterator<number> {
  const iter = arr[Symbol.iterator]() as IterableIterator<number> & { _next: IterableIterator<number>["next"] };
  iter._next = iter.next;
  iter.next = () => { const r = iter._next(); if (r.value) r.value = r.value * 10; return r; };
  return iter;
}
function main(): void {
  const it: IterableIterator<number> = g();
  const n = it.next;
  console.log(typeof n, JSON.stringify(it.next()), JSON.stringify(n.call(it)), JSON.stringify(it.next()));
  const out: number[] = [];
  for (const v of wrap([7, 8, 9])) out.push(v);
  console.log(out.join(","), [...wrap([1, 2])].join(","), Array.from(wrap([3])).join(","));
  const w = wrap([4, 5]);
  let r = w.next();
  const seen: string[] = [];
  while (!r.done) { seen.push(String(r.value)); r = w.next(); }
  console.log(seen.join(","), r.done, typeof w[Symbol.iterator]);
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  const mi = m.entries() as IterableIterator<[string, number]> & { _next: IterableIterator<[string, number]>["next"] };
  mi._next = mi.next;
  mi.next = () => { const r2 = mi._next(); if (r2.value) r2.value = [r2.value[0].toUpperCase(), r2.value[1] * 2]; return r2; };
  const pairs: string[] = [];
  for (const [k, v] of mi) pairs.push(k + v);
  console.log(pairs.join(","));
}
main();
