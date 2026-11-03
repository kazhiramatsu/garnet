// A comparator's calls, in order, and what an inconsistent one leaves.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function hash(xs: number[]): number { let h = 7; for (const x of xs) h = (Math.imul(h, 31) + x) | 0; return h; }
function logged(a: number[], cmp: (x: number, y: number) => number): string {
  const calls: number[] = [];
  const sorted = a.slice().sort((x, y) => { calls.push(x, y); return cmp(x, y); });
  return calls.length + ":" + hash(calls) + ":" + hash(sorted);
}
const r = rng(1234);
const out: string[] = [];
for (const n of [0, 1, 2, 3, 5, 8, 13, 31, 32, 33, 63, 64, 65, 100, 127, 128, 129, 200, 500, 1000, 2047, 2048, 5000, 20000]) {
  const random: number[] = []; for (let i = 0; i < n; i++) random.push(Math.floor(r() * 1000));
  const asc: number[] = []; for (let i = 0; i < n; i++) asc.push(i);
  const desc = asc.slice().reverse();
  const saw: number[] = []; for (let i = 0; i < n; i++) saw.push(i % 17 < 9 ? i : n - i);
  const runs: number[] = []; for (let i = 0; i < n; i++) runs.push((i % 100) * 3 + (i >> 7));
  const dups: number[] = []; for (let i = 0; i < n; i++) dups.push(Math.floor(r() * 4));
  const nearly = asc.slice(); for (let i = 0; i + 1 < n; i += 37) { const t = nearly[i]; nearly[i] = nearly[i + 1]; nearly[i + 1] = t; }
  for (const a of [random, asc, desc, saw, runs, dups, nearly]) {
    out.push(logged(a, (x, y) => x - y));
    out.push(logged(a, (x, y) => y - x));
    out.push(logged(a, (x, y) => (x > y ? 1 : 0)));          // inconsistent: never negative
    out.push(logged(a, (x, y) => (x < y ? -1 : 0)));         // inconsistent: never positive
    out.push(logged(a, (x, y) => (x & 7) - (y & 7)));        // stable on the low bits
    out.push(logged(a, (x, y) => ((x * 31 + y * 17) % 3) - 1));  // nonsense
  }
}
let h = 0; for (const s of out) for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
console.log(out.length, h);
for (let i = 0; i < out.length; i += 6) console.log(i, out.slice(i, i + 6).join(" "));
// default order, undefineds, holes
console.log([3, 20, 100, 1, -5, -10, 0, 2.5, 1e21, NaN, Infinity].sort());
console.log(["b", "a", undefined, "c", , "aa", "B", "é", "z"].sort());
console.log([, 1, , 2, undefined, 3, ,].sort((a: any, b: any) => b - a), [3, , 1].length);
console.log([5, 25, 100, 1, 3, 12].sort().join(), [true, false, null, 0, "x", {}].sort().join());
class P { constructor(public k: number, public v: string) {} }
const ps: P[] = []; for (let i = 0; i < 300; i++) ps.push(new P(i % 5, "v" + i));
ps.sort((a, b) => a.k - b.k);
console.log(ps.slice(0, 5).map((p) => p.v).join(), ps.slice(-3).map((p) => p.v).join());
// a comparator that throws, that changes the array, a bad comparator
const t = [3, 2, 1];
try { t.sort(() => { throw new Error("boom"); }); } catch (e: any) { console.log(e.message, t); }
const m = [5, 4, 3, 2, 1];
m.sort((a, b) => { m.length = 0; return a - b; }); console.log(m, m.length);
const g = [5, 4, 3, 2, 1];
g.sort((a, b) => { g.push(9); return a - b; }); console.log(g.length, g.slice(0, 6));
for (const bad of [null, 1, "x", {}, true, []]) { try { [1, 2].sort(bad as any); console.log("no throw"); } catch (e: any) { console.log(e.name, e.message); } }
try { (Object.freeze([2, 1]) as any).sort(); } catch (e: any) { console.log(e.name, e.message); }
console.log((Object.freeze([1]) as any).sort());
console.log([1, 2, 3].sort(undefined), ([3, 2, 1] as any).toSorted(), ([3, 1, 2] as any).toSorted((a: number, b: number) => b - a));
console.log(new Float64Array([3, 1, 2]).sort(), new Int8Array([3, 1, 2]).sort((a, b) => b - a));
const ao: any = { 0: "b", 1: "a", 2: "c", length: 3 };
console.log(Array.prototype.sort.call(ao));
const coll = ["ä", "a", "z"].sort((a, b) => a.localeCompare(b)); console.log(coll);
