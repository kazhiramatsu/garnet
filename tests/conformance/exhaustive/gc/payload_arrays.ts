// Element buffers and sparse tables in the payload heap (docs/gc_v2_design.md
// §6.1, slice G2b): an array's buffer is released, without a visit, when a
// collection does not mark it through its array; growth replaces the buffer
// (the old one is freed explicitly); dense and sparse forms convert both ways.
function grow(n: number, seed: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(seed + i);
  return a;
}
function churn(rounds: number): number {
  let acc = 0;
  for (let i = 0; i < rounds; i++) {
    const t = grow(5 + (i % 40), i);
    const u = t.map((x) => x * 2);
    acc += u[u.length - 1] + t.length;
  }
  return acc;
}
// long-lived arrays that keep growing after they are promoted
const lists: number[][] = [];
for (let i = 0; i < 40; i++) lists.push(grow(3, i * 100));
let total = 0;
for (let round = 0; round < 60; round++) {
  for (let i = 0; i < lists.length; i++) lists[i].push(round + i);
  total += churn(120);
  if (round % 10 === 9) lists.splice(round % 7, 3, grow(9, round), grow(70, round));
}
let sum = 0;
for (const l of lists) for (const x of l) sum += x;
console.log(total, lists.length, sum);

// large buffers (beyond the small classes) that die and are replaced
let big: number[] = [];
let bigSum = 0;
for (let r = 0; r < 6; r++) {
  big = grow(6000 + r * 1500, r);
  churn(40);
  bigSum += big[big.length - 1] + big.length;
}
console.log(bigSum, big.length);

// sparse tables: far stores convert to the sparse form, dense again later
const sparseKeep: any[][] = [];
for (let w = 0; w < 30; w++) {
  const c: any[] = [];
  for (let k = 0; k < 20; k++) c[100000 + w * 1000 + k * 37] = { id: k + w };
  churn(10);
  if (w % 3 === 0) sparseKeep.push(c);
}
let sp = 0;
for (const c of sparseKeep) for (const k in c) sp += c[k].id + Number(k) % 7;
console.log(sparseKeep.length, sp);
const dense: any[] = [];
dense[50000] = 1;
for (let i = 0; i < 50000; i++) dense[i] = i & 3;
churn(50);
let ds = 0;
for (let i = 0; i <= 50000; i++) ds += dense[i];
console.log(dense.length, ds);

// splice rebuilds of a long-lived array
const keep: string[] = [];
for (let i = 0; i < 300; i++) {
  keep.push("k" + i);
  if (i % 17 === 0) keep.splice(i % 5, 2, "x" + i, "y" + i, "z" + i);
  if (i % 50 === 0) churn(30);
}
console.log(keep.length, keep.slice(0, 6).join(","), keep[keep.length - 1]);
