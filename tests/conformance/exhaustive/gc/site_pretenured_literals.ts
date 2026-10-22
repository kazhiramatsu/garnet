// Allocation-site pretenuring, slice 2 (docs/site_pretenuring_design.md):
// object literals and arrays from sites whose cells survive their first
// collection allocate old. Old arrays then grow and take young elements, old
// literals take young values and new properties, and a site whose cells stop
// surviving goes back to young.
type Entry = { key: string; value: number; tags: string[]; next: Entry | null };

// Allocations returned from factories: no static strategy claims them.
function entry(i: number, next: Entry | null): Entry {
  return { key: "k" + i, value: i * 3, tags: [], next };
}
function empty(): any { return {}; }
function pair(i: number): number[] { return [i, i + 1]; }
function rec(i: number): { k: number; s: string } { return { k: i, s: "r" + (i % 29) }; }

// Short-lived literals and arrays from sites of their own.
const ring: any[] = [];
function churn(n: number, seed: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const o = { a: i, b: seed, c: [i, seed] };
    ring[i & 63] = o;
    acc += o.a - o.c[0] + o.b;
  }
  return acc;
}

// 1. long-lived literals, empty objects and arrays: their sites tenure
const entries: Entry[] = [];
let prev: Entry | null = null;
for (let i = 0; i < 60000; i++) { prev = entry(i, i % 10 === 0 ? null : prev); entries.push(prev); }
const bags: any[] = [];
for (let i = 0; i < 60000; i++) bags.push(empty());
const pairs: number[][] = [];
for (let i = 0; i < 60000; i++) pairs.push(pair(i));
let churned = churn(300000, 1);

// 2. old arrays grow past their inline elements and take young values;
//    old literals take young values and new properties
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  for (let j = 0; j < 6; j++) e.tags.push("t" + ((i + j) % 17));
  if (i % 7 === 0) e.next = entry(-i, null);
}
for (let i = 0; i < bags.length; i++) {
  const b = bags[i];
  b.label = "b" + i;
  b.items = [i, "x" + i];
  if (i % 3 === 0) b.nested = { deep: ["d" + i] };
}
for (let i = 0; i < pairs.length; i++) { pairs[i].push(i * 2); pairs[i][5] = i; }
churned += churn(300000, 2);

let check1 = 0;
for (const e of entries) {
  check1 += e.key.length + e.value + e.tags.length + e.tags[5].length;
  if (e.next) check1 += e.next.key.length + e.next.value;
}
let check2 = 0;
for (let i = 0; i < bags.length; i++) {
  const b = bags[i];
  check2 += b.label.length + b.items[0] + b.items[1].length;
  if (i % 3 === 0) check2 += b.nested.deep[0].length;
}
let check3 = 0;
for (const p of pairs) check3 += p[0] + p[1] + p[2] + p[5] + p.length;
console.log("entries", check1, "bags", check2, "pairs", check3, churned);

// 3. a phase change: the site's records lived, then they die
const recs: { k: number; s: string }[] = [];
for (let i = 0; i < 100000; i++) recs.push(rec(i));
let recSum = 0;
for (let i = 0; i < 600000; i++) { const r = rec(i); recSum += r.s.length + (r.k & 1); }
let check4 = 0;
for (const r of recs) check4 += r.k + r.s.length;
let tail = 0;
for (const e of entries) tail += e.value & 7;
for (const b of bags) tail += b.items.length;
for (const p of pairs) tail += p.length;
console.log("recs", check4, recSum, "tail", tail);
