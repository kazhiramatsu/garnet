// Class instances the escape analysis keeps on the stack take dynamic
// properties: they stay sized and unshaped (docs/cell_header_design.md), so
// the added properties go to the dictionary and never over the struct fields.
// Header-only instances (a class without fields) take them too.
class P3 { x: number; y: number; tag: any; constructor(x: number, y: number) { this.x = x; this.y = y; this.tag = null; } }
class Wide { a: any = 1; b: any = 2; c: any = 3; d: any = 4; e: any = 5; f: any = 6; g: any = 7; h: any = 8; i: any = 9; }
class Bare { label(): string { return "bare"; } }
function churn(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { const t = { a: i, b: [i] }; s = (s + t.a + t.b.length) % 1000; }
  return s;
}
function local(i: number): number {
  const p = new P3(i, i + 1);
  const d: any = p;
  d.extra = i * 3;
  d.more = "m" + i;
  d.obj = { k: i };
  if (i % 50 === 0) churn(2000);
  return p.x + p.y + d.extra + d.more.length + d.obj.k + (p.tag === null ? 1 : 0);
}
function wide(i: number): string {
  const w = new Wide();
  const d: any = w;
  d.p0 = i; d.p1 = 2 * i; d.p2 = 3 * i; d.p3 = 4 * i; d.p4 = 5 * i; d.p5 = 6 * i;
  d.p6 = 7 * i; d.p7 = 8 * i; d.p8 = 9 * i; d.p9 = 10 * i; d.p10 = { k: i }; d.p11 = "s" + i;
  w.e = { at: i };
  if (i % 20 === 0) churn(2000);
  const s = d.p0 + d.p1 + d.p2 + d.p3 + d.p4 + d.p5 + d.p6 + d.p7 + d.p8 + d.p9 + d.p10.k + d.p11.length;
  return "" + w.a + w.b + w.c + w.d + w.e.at + w.f + w.g + w.h + w.i + ":" + s;
}
function bare(i: number): string {
  const b = new Bare();
  const d: any = b;
  d.v = i;
  d.w = [i, i];
  return b.label() + d.v + d.w.length;
}
function main(): void {
  let s = 0;
  for (let i = 0; i < 400; i++) s += local(i);
  console.log("local", s);
  let t = "";
  for (let i = 0; i < 60; i += 7) t += wide(i) + " ";
  console.log("wide", t);
  let u = "";
  for (let i = 0; i < 5; i++) u += bare(i) + " ";
  console.log("bare", u);
}
main();
