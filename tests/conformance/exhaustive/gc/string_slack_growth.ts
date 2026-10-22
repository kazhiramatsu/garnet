// String builders grow in place up to their cell's capacity
// (docs/cell_header_design.md): a small cell's size class, a large cell's
// request. Cells recycled after collections still hold their previous
// contents past the request; appends write their units and the terminator,
// so every result reads exactly. 8-bit and UTF-16 builders, small and large.
function garbage(n: number, seed: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = "g" + (seed + i) + "#".repeat((i % 40) + 1) + String.fromCharCode(0x41 + (i % 26));
    s += t.length;
  }
  return s;
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function build(n: number, piece: string): string {
  let s = "";
  for (let i = 0; i < n; i++) s += piece + (i % 10);
  return s;
}
function grow(base: string, k: number): string {
  let s = base;
  for (let i = 0; i < k; i++) s = s + String.fromCharCode(97 + (i % 26));
  return s;
}
function main(): void {
  let g = garbage(50000, 1);   // fill cells, then let them die
  const out: string[] = [];
  for (let round = 0; round < 3; round++) {
    g += garbage(20000, round);
    for (let n = 1; n < 40; n += 3) {
      const a = build(n, "ab");
      const b = build(n, "é");          // Latin-1 range: still 8-bit
      const c = build(n, "あ");          // UTF-16
      out.push(a.length + ":" + hash(a) + "," + b.length + ":" + hash(b) + "," + c.length + ":" + hash(c));
    }
    for (let k = 1; k < 70; k += 5) {
      const s = grow("seed" + round, k);
      const t = grow("α" + round, k);   // UTF-16 base
      out.push(s.length + ":" + hash(s) + ":" + s.slice(-3) + "," + t.length + ":" + hash(t));
    }
    // views of one buffer: only the live tail extends in place
    let base = build(5, "v");
    const v1 = base + "1";
    const v2 = base + "2";
    const v3 = v1 + "x";
    out.push(v1 + "|" + v2 + "|" + v3 + "|" + base);
  }
  // large builders: past the small classes, grown near their request
  let big = "";
  for (let i = 0; i < 9000; i++) big += "q" + (i % 7);
  const big2 = big + "tail";
  let wide = "";
  for (let i = 0; i < 9000; i++) wide += "一" + (i % 5);
  g += garbage(30000, 9);
  out.push(big.length + ":" + hash(big) + "," + big2.length + ":" + hash(big2) + "," + wide.length + ":" + hash(wide));
  console.log(out.length, hash(out.join(";")), g > 0);
  for (let i = 0; i < out.length; i += 9) console.log(out[i]);
}
main();
