// Array literals whose elements the allocation stores (the exporter evaluates the elements first,
// the emitter fuses the allocation and the index stores): every size class (the four inline slots,
// the compact cell up to 64, an element payload beyond), the evaluation order of the elements, an
// element that throws (no array, the earlier elements' effects kept), literals in a loop (a fresh
// array each time), nested literals, growth and mutation after the literal in each size class,
// the same local twice, numeric and string elements, a literal of literals held across collections,
// holes and spreads (the other lowering), an empty literal.
const log: string[] = [];
function tick(s: string): string { log.push(s); return s; }
function boom(): number { throw new Error("boom"); }
function make(n: number): number[] { const out: number[] = []; for (let i = 0; i < n; i++) out.push(i * i); return out; }
function main() {
  const out: unknown[] = [];
  const a1 = [tick("a")], a2 = [tick("b"), tick("c")], a4 = [1, 2, 3, 4], a5 = [1, 2, 3, 4, 5];
  out.push(a1, a2, a4, a5, log.join(""));
  const a64 = make(64), a65 = make(65), a70 = make(70);
  const l64 = [a64[0], a64[1], a64[2], a64[3], a64[4], a64[5], a64[6], a64[7], a64[8], a64[9], a64[10], a64[11], a64[12], a64[13], a64[14], a64[15],
    a64[16], a64[17], a64[18], a64[19], a64[20], a64[21], a64[22], a64[23], a64[24], a64[25], a64[26], a64[27], a64[28], a64[29], a64[30], a64[31],
    a64[32], a64[33], a64[34], a64[35], a64[36], a64[37], a64[38], a64[39], a64[40], a64[41], a64[42], a64[43], a64[44], a64[45], a64[46], a64[47],
    a64[48], a64[49], a64[50], a64[51], a64[52], a64[53], a64[54], a64[55], a64[56], a64[57], a64[58], a64[59], a64[60], a64[61], a64[62], a64[63]];
  const l65 = [...l64, a65[64]];
  const l70 = [a70[0], a70[1], a70[2], a70[3], a70[4], a70[5], a70[6], a70[7], a70[8], a70[9], a70[10], a70[11], a70[12], a70[13], a70[14], a70[15],
    a70[16], a70[17], a70[18], a70[19], a70[20], a70[21], a70[22], a70[23], a70[24], a70[25], a70[26], a70[27], a70[28], a70[29], a70[30], a70[31],
    a70[32], a70[33], a70[34], a70[35], a70[36], a70[37], a70[38], a70[39], a70[40], a70[41], a70[42], a70[43], a70[44], a70[45], a70[46], a70[47],
    a70[48], a70[49], a70[50], a70[51], a70[52], a70[53], a70[54], a70[55], a70[56], a70[57], a70[58], a70[59], a70[60], a70[61], a70[62], a70[63],
    a70[64], a70[65], a70[66], a70[67], a70[68], a70[69]];
  out.push(l64.length, l64.join(",") === a64.join(","), l65.length, l65[64], l70.length, l70.join(",") === a70.join(","));
  // the evaluation order, and an element that throws
  log.length = 0;
  let threw = "";
  try { const t = [tick("x"), boom(), tick("z")]; out.push(t.length); } catch (e) { threw = (e as Error).message; }
  out.push(threw, log.join(""));
  // literals in a loop: fresh arrays, each kept
  const kept: number[][] = [];
  for (let i = 0; i < 5; i++) { const p = [i, i * 10]; kept.push(p); p.push(i * 100); }
  out.push(kept, kept[0] !== kept[1]);
  // growth and mutation after the literal in each size class
  const g1 = ["a"]; g1.push("b", "c", "d", "e"); g1.unshift("z"); out.push(g1, g1.length);
  const g4 = [1, 2, 3, 4]; g4.push(5); g4.splice(1, 2, 9, 9, 9); out.push(g4);
  const g6 = [1, 2, 3, 4, 5, 6]; g6.push(7); g6.shift(); g6[10] = 11; out.push(g6, g6.length, 8 in g6);
  const g = l70.slice(); g.push(-1); g.length = 3; out.push(g);
  // the same local twice, mixed elements, nested literals, an object element
  const s = "s", n = 2.5, k = 7, o = { k };
  const m = [s, s, n, k, k + 1, o, [s, [n]], null, undefined, true];
  out.push(m, m[5] === o, m[0] === m[1]);
  // a string built by concatenation as an element, and a literal of literals held across collections
  let acc = ""; for (let i = 0; i < 20; i++) acc += i; const w = [acc, acc.length];
  const grid: number[][][] = [];
  for (let i = 0; i < 2000; i++) grid.push([[i], [i, i], [i, i, i, i, i, i]]);
  let sum = 0; for (const row of grid) for (const cell of row) for (const v of cell) sum += v;
  out.push(w, sum, grid[1999][2].length);
  // holes, spreads and the empty literal keep their lowering
  const h = [1, , 3], sp = [0, ...a2, 9], e: number[] = [];
  out.push(h.length, 1 in h, sp, e.length, [[]].length);
  console.log(JSON.stringify(out));
}
main();
