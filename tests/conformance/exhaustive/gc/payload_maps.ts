// Map and Set buffers in the payload heap (docs/gc_v2_design.md §6.1, slice
// G2d): the dense key/value/hash arrays, the slot index and the iteration
// order of a Map or Set are released, without a visit, when a collection does
// not mark them through the collection; growth replaces them; deletions
// compact them and rebuild the index; WeakMap pruning compacts during a
// collection (its new index is allocated marked).
function churn(rounds: number): number {
  let acc = 0;
  for (let i = 0; i < rounds; i++) {
    const m = new Map<string, number>();
    for (let k = 0; k < 5 + (i % 30); k++) m.set("k" + k, k);
    const s = new Set<number>();
    for (const v of m.values()) s.add(v * 2);
    acc += m.size + s.size + (m.get("k3") ?? 0);
  }
  return acc;
}
// long-lived maps and sets that keep growing and shrinking after promotion
const maps: Map<number, string>[] = [];
const sets: Set<string>[] = [];
for (let i = 0; i < 20; i++) { maps.push(new Map()); sets.push(new Set()); }
let total = 0;
for (let round = 0; round < 40; round++) {
  for (let i = 0; i < maps.length; i++) {
    for (let k = 0; k < 6; k++) maps[i].set(round * 10 + k, "v" + round + "_" + k);
    sets[i].add("s" + round + "_" + i);
    if (round % 3 === 2) for (let k = 0; k < 4; k++) maps[i].delete((round - 2) * 10 + k);
    if (round % 5 === 4) sets[i].delete("s" + (round - 1) + "_" + i);
  }
  total += churn(60);
}
let ms = 0, ss = 0, order = "";
for (const m of maps) for (const [k, v] of m) ms += k + v.length;
for (const s of sets) for (const v of s) ss += v.length;
for (const [k] of maps[3]) if (order.length < 40) order += k + ",";
console.log(total, ms, ss, maps[0].size, sets[0].size, order);

// clear and reuse
const reuse = new Map<string, number>();
for (let r = 0; r < 5; r++) {
  for (let k = 0; k < 200; k++) reuse.set("x" + k + "_" + r, k);
  churn(20);
  if (r < 4) reuse.clear();
}
let rs = 0;
for (const v of reuse.values()) rs += v;
console.log(reuse.size, rs, reuse.get("x199_4"), reuse.has("x1_3"));

// WeakMap and WeakSet entries whose keys die are pruned by collections
const wm = new WeakMap<object, number>();
const ws = new WeakSet<object>();
const keepKeys: object[] = [];
for (let i = 0; i < 3000; i++) {
  const key = { i };
  wm.set(key, i);
  ws.add(key);
  if (i % 10 === 0) keepKeys.push(key);
  if (i % 300 === 0) churn(40);
}
churn(200);
let wsum = 0, wcount = 0;
for (const k of keepKeys) { wsum += wm.get(k) ?? -100000; if (ws.has(k)) wcount++; }
console.log(keepKeys.length, wsum, wcount);

// A young WeakMap pruned by a minor collection: the compaction rebuilds its
// slot index during the collection, after the map was scanned; that index
// must be allocated marked, or it would be free once the collection ends.
let sink: any[] = [];
function churnObjects(n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) { sink.push({ a: i, b: "x" + i }); if (sink.length > 1000) { c += sink.length; sink = []; } }
  return c;
}
function youngWeak(seed: number): number {
  const w = new WeakMap<object, number>();
  const live: object[] = [];
  for (let i = 0; i < 400; i++) { const k = { i }; w.set(k, i + seed); if (i % 4 === 0) live.push(k); }
  let junk = churnObjects(60000);
  let s = 0;
  for (const k of live) s += w.get(k) ?? -1000;
  for (let i = 0; i < 100; i++) { const k = { i }; w.set(k, i); live.push(k); }
  junk += churnObjects(30000);
  for (const k of live) s += w.get(k) ?? -1000;
  return s + junk;
}
let yw = 0;
for (let r = 0; r < 4; r++) yw += youngWeak(r);
console.log(yw);
