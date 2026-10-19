// Scope records (the capture context of a function's mutable captured
// variables) on the C stack (docs/stack_records_design.md): a record that no
// closure or callee retains beyond the activation lives in the frame. Every
// path by which a record outlives its activation keeps it on the heap: a
// closure returned, stored in a module array, kept by a builtin (then, Map.set,
// push, bind), passed to a direct helper that stores it, created in a nested
// function and stored, a generator or async body (the frame is a state
// machine), and a closure stored into the record itself and then returned.
// The stack records hold young objects across collections: nested functions
// allocate while the record points at fresh objects.
class Box { constructor(public v: number) {} }
const keptClosures: (() => number)[] = [];
const table = new Map<number, () => number>();
const pending: Promise<number>[] = [];
function keep(cb: () => number): void { keptClosures.push(cb); }
function callTwice(cb: () => number): number { return cb() + cb(); }
function churn(): void { for (let i = 0; i < 100000; i++) { const t = new Box(i); if (t.v < 0) console.log(t.v); } }
// 1. record used only by nested direct functions and local callbacks
function local(n: number): number {
  let acc = 0;
  let last: Box | undefined;
  function add(x: number): void { acc += x; last = new Box(acc); }
  function addAll(xs: number[]): void { for (const x of xs) add(x); }
  addAll([n, n + 1, n + 2]);
  churn();                                 // the record holds a young Box across collections
  const sum = callTwice(() => acc + (last ? last.v : 0));
  [1, 2].forEach(x => { acc += x; });
  return sum + acc + (last ? last.v : 0);
}
// 2. the classic counter: the record escapes with the returned closure
function counter(start: number): () => number {
  let n = start;
  return () => ++n;
}
// 3. stored by a module array, a Map, a promise, a bound function
function retained(i: number): void {
  let n = i;
  keptClosures.push(() => n * 2);
  table.set(i, () => { n += 1; return n; });
  pending.push(Promise.resolve(i).then(v => v + n));
  const bound = ((k: number) => k + n).bind(null, 1);
  keep(() => bound(0));
}
// 4. passed to a direct helper that stores it; created in a nested function and stored
function viaHelper(i: number): void {
  let n = i * 3;
  keep(() => n);
  function nested(): void { keep(() => n + 1); }
  nested();
}
// 5. a closure stored into the record itself, then returned through a field
function selfRef(i: number): { get: () => number } {
  let n = i;
  let self: (() => number) | undefined;
  self = () => n + (self ? 1 : 0);
  return { get: self };
}
// 6. generator and async bodies keep their records on the heap
function* gen(i: number): Generator<number, void, unknown> {
  let n = i;
  const bump = () => ++n;
  yield bump();
  churn();
  yield bump();
}
async function asyncBody(i: number): Promise<number> {
  let n = i;
  const bump = () => ++n;
  await Promise.resolve();
  churn();
  return bump() + n;
}
// 7. deep recursion with a record per frame
function deep(d: number): number {
  let acc = d;
  function inc(): void { acc += 1; }
  inc();
  return d === 0 ? acc : acc + deep(d - 1);
}
async function main(): Promise<void> {
  let total = 0;
  for (let i = 0; i < 20; i++) { total += local(i); retained(i); viaHelper(i); }
  const c = counter(10); c(); c();
  const s = selfRef(5);
  const g = gen(100);
  const genSum = (g.next().value as number) + (g.next().value as number);
  const asyncSum = await asyncBody(7);
  churn();
  let kept = 0;
  for (const cb of keptClosures) kept += cb();
  for (const cb of table.values()) kept += cb();
  for (const p of pending) kept += await p;
  console.log(total, c(), s.get(), genSum, asyncSum, kept, keptClosures.length, deep(500));
}
main();
