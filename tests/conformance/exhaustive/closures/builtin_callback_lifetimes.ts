// Callbacks handed to builtins that call but do not retain them (array
// iteration methods, the comparator of sort, Map/Set forEach, the function
// form of replace, Array.from's map function) may live on the C stack; the
// callbacks that a builtin or a container keeps (then, Map.set, push, bind,
// a closure created inside the callback and stored outside) must not, and a
// captured object that a callback returns escapes with the result. Every
// result is read back after enough allocation to force collections.
class Box { constructor(public v: number) {} }
const kept: (() => number)[] = [];
const table = new Map<number, () => number>();
let pending: Promise<number>[] = [];
function churn(): void { for (let i = 0; i < 200000; i++) { const t = new Box(i); if (t.v < 0) console.log(t.v); } }
function iterate(xs: number[], base: number): number {
  const b = new Box(base);
  let acc = 0;
  xs.forEach(x => { acc += x + b.v; });
  const some = xs.some(x => x + b.v > 100);
  const every = xs.every(x => x + b.v > 0);
  const filtered = xs.filter(x => (x + b.v) % 2 === 0);
  const mapped = xs.map(x => ({ v: x + b.v }));
  const found = xs.find(x => x + b.v === base + 2);
  const idx = xs.findIndex(x => x + b.v === base + 3);
  const flat = xs.flatMap(x => [x, x + b.v]);
  const sum = xs.reduce((s, x) => s + x + b.v, 0);
  const sumR = xs.reduceRight((s, x) => s + x - b.v, 0);
  const sorted = xs.slice().sort((p, q) => (q + b.v) - (p + b.v));
  const fromIt = Array.from(xs, x => x * b.v);
  const text = "a1b22c333".replace(/\d+/g, m => String(m.length + b.v));
  const m = new Map<number, number>([[1, 10], [2, 20]]);
  m.forEach((val, key) => { acc += val * key + b.v; });
  const st = new Set<number>([3, 4]);
  st.forEach(val => { acc += val - b.v; });
  return acc + (some ? 1 : 0) + (every ? 2 : 0) + filtered.length + mapped.reduce((s, o) => s + o.v, 0) + (found ?? -1) + idx + flat.length + sum + sumR + sorted[0] + fromIt[1] + text.length;
}
function retain(xs: number[], base: number): void {
  const b = new Box(base);
  xs.forEach(x => { kept.push(() => x + b.v); });        // created inside the callback, stored outside
  table.set(base, () => b.v * 2);                         // Map.set keeps it
  kept.push(() => b.v + 1);                               // push keeps it
  pending.push(Promise.resolve(base).then(v => v + b.v)); // then keeps it
  const bound = ((k: number) => k + b.v).bind(null, 5);   // bind keeps the target
  kept.push(() => bound(0));
}
function helper(cb: () => Box): Box { return cb(); }
const boxes: Box[] = [];
function viaHelper(i: number): void {
  const b = new Box(i * 3);
  boxes.push(helper(() => b));                           // returned through a callback a direct helper calls
}
function mapsCaptured(base: number): number[] {
  const b = new Box(base);
  // a callback that returns a captured object: the result retains it
  const boxes = [1, 2, 3].map(() => b);
  churn();
  return boxes.map(x => x.v);
}
async function main(): Promise<void> {
  const xs = [1, 2, 3, 4, 5];
  let total = 0;
  for (let i = 0; i < 30; i++) { total += iterate(xs, i); retain(xs, i); viaHelper(i); }
  const captured = mapsCaptured(7);
  churn();
  let s = 0;
  for (const cb of kept) s += cb();
  for (const cb of table.values()) s += cb();
  for (const p of pending) s += await p;
  for (const b of boxes) s += b.v;
  console.log(total, s, kept.length, table.size, captured.join(","), boxes.length);
}
main();
