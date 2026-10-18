// Object literal and constructor layouts: key order, enumeration, values
// computed between stores (side effects, throws), spread after a prefix,
// literals in loops, constructor functions through `new` and `.call`.
function side(log: string[], v: number): number { log.push("v" + v); return v; }
function lit(log: string[]): { a: number; b: number; c: string; d?: number } {
  return { a: side(log, 1), b: side(log, 2), c: "x" };
}
function throwing(): never { throw new Error("mid"); }
function partial(): any {
  try { return { p: 1, q: throwing(), r: 3 }; } catch (e) { return "caught"; }
}
function spreadAfter(extra: object): any { return { a: 1, b: 2, ...extra, z: 9 }; }
function nested(): any { return { outer: { inner: 1, list: [1, 2] }, flag: true }; }
function Point(this: any, x: number, y: number) { this.x = x; this.y = y; this.len = Math.sqrt(x * x + y * y); }
function Pair(this: any, k: string, v: number) { this.k = k; this.v = v; }
function Wide(this: any, n: number) {
  this.a = n; this.b = n + 1; this.c = n + 2; this.d = n + 3; this.e = n + 4; this.f = n + 5; this.g = n + 6;
  this.h = n + 7; this.i = n + 8; this.j = n + 9; this.k = n + 10; this.l = n + 11; this.m = n + 12; this.n = n + 13;
}
function main(): void {
  const log: string[] = [];
  const o = lit(log);
  console.log(Object.keys(o).join(","), log.join(","), JSON.stringify(o), "d" in o, o.a + o.b, o.c);
  o.d = 4; console.log(Object.keys(o).join(","), JSON.stringify(o));
  console.log(partial());
  console.log(JSON.stringify(spreadAfter({ b: 20, c: 30 })), JSON.stringify(spreadAfter({})));
  console.log(JSON.stringify(nested()));
  const pts: any[] = []; for (let i = 0; i < 5; i++) pts.push({ x: i, y: i * 2, tag: "p" + i });
  console.log(JSON.stringify(pts), Object.keys(pts[3]).join(","));
  const P = Point as unknown as new (x: number, y: number) => any;
  const p = new P(3, 4); console.log(Object.keys(p).join(","), p.len, JSON.stringify(p));
  const viaCall: any = {}; (Point as any).call(viaCall, 6, 8); console.log(Object.keys(viaCall).join(","), viaCall.len);
  const nonEmpty: any = { pre: 1 }; (Point as any).call(nonEmpty, 1, 1); console.log(Object.keys(nonEmpty).join(","), JSON.stringify(nonEmpty));
  const PairC = Pair as unknown as new (k: string, v: number) => any;
  const pairs: any[] = []; for (let i = 0; i < 4; i++) pairs.push(new PairC("k" + i, i));
  pairs[1].extra = true; console.log(JSON.stringify(pairs), Object.keys(pairs[1]).join(","));
  const WideC = Wide as unknown as new (n: number) => any;
  const w = new WideC(100); w.o = 1; console.log(Object.keys(w).join(","), w.a + w.n + w.o);
  const w2 = new WideC(0); delete w2.c; w2.c = 5; console.log(Object.keys(w2).join(","), JSON.stringify(w2));
}
main();
