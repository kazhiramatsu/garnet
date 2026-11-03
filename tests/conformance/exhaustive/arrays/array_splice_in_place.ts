function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; }; }
const r = rng(5);
function model(a: number[], s: number, d: number, items: number[]) { const out: number[] = []; for (let i = 0; i < s; i++) out.push(a[i]); for (const x of items) out.push(x); for (let i = s + d; i < a.length; i++) out.push(a[i]); return out; }
let bad = 0, h = 0;
for (let round = 0; round < 400; round++) {
  const n = r() % 80;
  let a: number[] = []; for (let i = 0; i < n; i++) a.push(i * 3);
  for (let k = 0; k < 60; k++) {
    const len = a.length;
    const s = len ? r() % (len + 1) : 0, d = r() % 4 === 0 ? r() % 300 : r() % 5;
    const items: number[] = []; const ni = r() % 4 === 0 ? r() % 40 : r() % 3; for (let i = 0; i < ni; i++) items.push(1000 + i);
    const dd = Math.min(d, len - s);
    const want = model(a, s, dd, items);
    const removedWant = a.slice(s, s + dd);
    const removed = a.splice(s, d, ...items);
    if (removed.join() !== removedWant.join() || a.join() !== want.join() || a.length !== want.length) bad++;
    if (k % 7 === 0) { a.shift(); a.unshift(5); a.push(6); }
    for (const x of a) h = (Math.imul(h, 31) + x) | 0;
  }
}
console.log(bad, h);
// a shrink, a growth, holes, the slots past the end
const q: any[] = []; for (let i = 0; i < 40; i++) q.push(i);
q.splice(0, 3); console.log(q.length, q[0], q[36], q[37]);
q.splice(30, 100); console.log(q.length, q[29], q[30], 30 in q);
q.splice(2, 0, "a", "b", "c"); console.log(q.length, q.slice(0, 6));
q.splice(1, 1); q.length = 40; console.log(q.length, q[39], 39 in q);
const hs = [1, , 3, , 5]; console.log(hs.splice(1, 2), hs, 1 in hs); console.log(hs.splice(0), hs);
const obj: any[] = []; for (let i = 0; i < 300; i++) obj.push({ i });
for (let i = 0; i < 280; i++) obj.splice(1, 1);
console.log(obj.length, obj.map((o) => o.i).join().slice(0, 40));
for (let i = 0; i < 300; i++) obj.splice(0, 0, { i: -i });
console.log(obj.length, obj[0].i, obj[299].i, obj[319].i);
const m: number[] = []; for (let i = 0; i < 100; i++) m.push(i);
for (let i = 0; i < 40; i++) m.splice(5, 2, i); console.log(m.length, m.slice(0, 8).join());
console.log(Object.freeze([1]).length);
