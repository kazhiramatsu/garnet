function deepMap<T>(arr: any[], f: (n: number) => number): any[] {
  return arr.map(x => Array.isArray(x) ? deepMap(x, f) : f(x));
}
function memoize<A, R>(f: (a: A) => R): (a: A) => R {
  const cache = new Map<A, R>();
  return (a: A) => { if (cache.has(a)) return cache.get(a)!; const r = f(a); cache.set(a, r); return r; };
}
function reduceGeneric<T, Acc>(arr: T[], f: (acc: Acc, t: T) => Acc, init: Acc): Acc {
  let acc = init; for (const x of arr) acc = f(acc, x); return acc;
}
function main(): void {
  console.log(JSON.stringify(deepMap([1, [2, [3, 4]], 5], x => x * 2)));  // [2,[4,[6,8]],10]
  let calls = 0;
  const sq = memoize((n: number) => { calls++; return n * n; });
  console.log(sq(4), sq(4), sq(5), calls);                                // 16 16 25 2
  console.log(reduceGeneric([1, 2, 3, 4], (a, b) => a + b, 0));           // 10
  console.log(reduceGeneric(["a", "b", "c"], (a, b) => a + b, ">"));      // >abc
  console.log(reduceGeneric([1, 2, 3], (a, b) => a.concat(b), [] as number[]).join(",")); // 1,2,3
}
main();
