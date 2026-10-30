// The young allocation in line (docs/alloc_fast_path_design.md): class instances, array literals
// of up to four elements and of more (in the cell, and past 256 bytes), object literals of a
// layout (boxed and integer slots, the first allocation resolving the layout), with enough
// allocations to cross runs and collections, values kept alive across them (a site whose cells
// survive is tenured: its later allocations take the runtime's call), and the fields read back.
class Pt { constructor(public x: number, public y: number) {} }
class Tag { name: string; n: number; constructor(name: string, n: number) { this.name = name; this.n = n; } }
class Empty {}

const kept: unknown[] = [];
let sum = 0;
for (let i = 0; i < 300000; i++) {
  const p = new Pt(i, i * 2);
  const t = new Tag("t" + (i % 7), i);
  const a2 = [i, p];
  const a4 = [i, i + 1, i + 2, t];
  const a7 = [i, 1, 2, 3, 4, 5, p];
  const a30 = [i, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, i];
  const o = { a: i, b: "s", c: p };
  const r = { count: i | 0, total: (i * 3) | 0 };
  const e = new Empty();
  sum += p.x + p.y + t.n + (a2[0] as number) + (a4[2] as number) + (a7[6] as Pt).y + (a30[29] as number);
  sum += o.a + (o.c as Pt).x + r.count + r.total + (e instanceof Empty ? 1 : 0);
  if (i % 1000 === 0) kept.push(p, t, a2, a4, a7, a30, o, r, e);
}
console.log(sum, kept.length);
let check = 0;
for (let k = 0; k < kept.length; k += 9) {
  const p = kept[k] as Pt, t = kept[k + 1] as Tag, a7 = kept[k + 4] as unknown[], o = kept[k + 6] as { a: number; c: Pt };
  const r = kept[k + 7] as { count: number; total: number };
  check += p.x + p.y + t.n + t.name.length + (a7[6] as Pt).x + o.a + o.c.y + r.count + r.total + (kept[k + 5] as number[]).length;
}
console.log(check);
console.log(JSON.stringify(kept[9 * 3]), JSON.stringify(kept[9 * 3 + 3]), JSON.stringify(kept[9 * 3 + 7]));
console.log(Object.keys(kept[9 * 5 + 6] as object), (kept[9 * 5 + 2] as unknown[]).length, Array.isArray(kept[9 * 5 + 4]));
// every cell of these sites survives (the factories return them into maps): the sites are tenured
// at run time, and their later allocations take the runtime's call
function mkPt(i: number): Pt { return new Pt(i, -i); }
function mkRow(i: number): number[] { return [i, i + 1, i + 2]; }
function mkRec(i: number): { a: number; b: number } { return { a: i, b: i * 2 }; }
const all = new Map<number, Pt>();
const rows = new Map<number, number[]>();
const recs = new Map<number, { a: number; b: number }>();
for (let i = 0; i < 200000; i++) { all.set(i, mkPt(i)); rows.set(i, mkRow(i)); recs.set(i, mkRec(i)); }
let s2 = 0;
for (let i = 0; i < all.size; i += 997) s2 += all.get(i)!.x - all.get(i)!.y + rows.get(i)![2] + recs.get(i)!.b;
console.log(s2, all.size, rows.size, recs.size);
