// Callback specialization: a module-level function passed as a callback to a
// module-level function binds the parameter in a clone, which calls it
// directly and specializes its own callees in turn. Every observable result
// must match V8: argument counts (extra and missing arguments), pass-through
// to another helper, recursion, a parameter also used as a value (unchanged
// path), a reassigned parameter (unchanged path), closures and arrows as
// callbacks (unchanged path), callbacks that throw, `this`-free targets, and
// the same helper called with several different callbacks.
type Comparer<T> = (a: T, b: T) => number;
function compareValues(a: number, b: number): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareDesc(a: number, b: number): number { return compareValues(b, a); }
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function identity<T>(x: T): T { return x; }
function getId(o: { id: number }): number { return o.id; }
function getIdCount(o: { id: number }, i: number): number { return o.id * 1000 + i; }
function throwing(a: number, b: number): number { if (a === 42) throw new Error("forty-two"); return compareValues(a, b); }
function binarySearchKey<T, U>(array: readonly T[], key: U, keySelector: (v: T, i: number) => U, keyComparer: Comparer<U>, offset?: number): number {
  if (array.length === 0) return -1;
  let low = offset ?? 0;
  let high = array.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const midKey = keySelector(array[middle], middle);
    switch (Math.sign(keyComparer(midKey, key))) {
      case -1: low = middle + 1; break;
      case 0: return middle;
      case 1: high = middle - 1; break;
    }
  }
  return ~low;
}
function binarySearch<T, U>(array: readonly T[], value: T, keySelector: (v: T) => U, keyComparer: Comparer<U>, offset?: number): number {
  return binarySearchKey(array, keySelector(value), keySelector, keyComparer, offset);
}
function sumBy<T>(array: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of array) s += f(x);
  return s;
}
function applyTwice(f: (n: number) => number, n: number): number { return f(f(n)); }
function double(n: number): number { return n * 2; }
function inc(n: number): number { return n + 1; }
function keep(f: (n: number) => number): (n: number) => number { return f; }
function countCalls(f: (n: number) => number, n: number): number { let c = 0; for (let i = 0; i < n; i++) c += f(i); return c; }
function reassigning(f: (n: number) => number, n: number): number { f = inc; return f(n); }
function recursiveFold(f: (a: number, b: number) => number, xs: number[], i: number): number {
  return i >= xs.length ? 0 : f(xs[i], recursiveFold(f, xs, i + 1));
}
function add(a: number, b: number): number { return a + b; }
function mul(a: number, b: number): number { return a * b; }
function withExtra(f: (a: number) => number, n: number): number { return (f as any)(n, 99, 100) + (f as any)(); }
function safeInc(a: number): number { return (a || 0) + 1; }
// module cells: the owner and the target capture module-level `let` bindings,
// which a direct call must thread into the clone
let tallyCount = 0;
let tallyBias = 10;
function biased(n: number): number { return n + tallyBias; }
function tally(f: (n: number) => number, n: number, extra?: number): number { tallyCount += f(n) + (extra ?? 0); return tallyCount; }
function tallyAll(f: (n: number) => number, xs: number[]): number { let t = 0; for (const x of xs) t = tally(f, x); return t; }
function main(): void {
  const nums = [1, 3, 5, 7, 9, 11, 13];
  const objs = nums.map((n) => ({ id: n }));
  const out: string[] = [];
  for (const q of [0, 1, 4, 5, 13, 14]) out.push(binarySearch(nums, q, identity, compareValues) + "/" + binarySearch(objs, { id: q }, getId, compareValues) + "/" + binarySearchKey(objs, q * 1000 + 3, getIdCount, compareValues, 2));
  console.log(out.join(" "));
  const desc = [13, 11, 9, 7];
  console.log(binarySearch(desc, 9, identity, compareDesc), binarySearch(desc, 8, identity, compareDesc), binarySearch(["a", "c", "e"], "d", identity, compareStrings), binarySearch([] as number[], 1, identity, compareValues));
  console.log(sumBy(objs, getId), sumBy(nums, double), sumBy(nums, inc), sumBy(nums, (x) => x * 3), applyTwice(double, 5), applyTwice(inc, 5), applyTwice((n) => n - 1, 5));
  console.log(keep(double)(4), keep(double) === keep(double), countCalls(inc, 10), countCalls(double, 10), reassigning(double, 5), recursiveFold(add, nums, 0), recursiveFold(mul, [1, 2, 3, 4], 0), withExtra(safeInc, 5));
  console.log(tally(biased, 1), tally(biased, 2, 5), tallyAll(biased, [1, 2, 3]), tallyAll(double, [4]), tallyCount);
  tallyBias = 100;
  console.log(tally(biased, 1), tallyAll(biased, [1]), tallyCount);
  try { binarySearch([42, 43], 42, identity, throwing); console.log("no throw"); } catch (e: any) { console.log("caught", e.message); }
  const local = (a: number, b: number) => compareValues(a, b);
  console.log(binarySearch(nums, 7, identity, local), binarySearch(nums, 7, (x) => x, compareValues), binarySearch(nums, 7, identity, (a, b) => a - b));
  let total = 0;
  for (let i = 0; i < 20000; i++) total += binarySearch(nums, (i % 15) + 1, identity, compareValues) + sumBy(objs, getId) + recursiveFold(add, [i, 1], 0);
  console.log(total);
}
main();
