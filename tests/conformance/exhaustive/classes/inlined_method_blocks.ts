// Methods and constructors the optimizer inlines into their caller when the
// object never leaves it (its fields become locals): a field read or write,
// or a call on `this`, inside an if, a ternary, a loop or a try block reads
// and writes the object's fields; a parameter the body assigns leaves the
// caller's argument alone.
class Matcher {
  readonly texts: string[];
  readonly last: number;
  readonly endText: string;
  pos: number;
  seg = 0;
  readonly found: number[] = [];
  constructor(texts: string[], endText: string, pos: number) {
    this.texts = texts;
    this.last = texts.length - 1;
    this.endText = endText;
    this.pos = pos;
  }
  text(index: number): string {
    return index < this.last ? this.texts[index]! : this.endText;
  }
  add(s: number, p: number): void {
    this.found.push(this.text(s).length + p);
    this.seg = s;
    this.pos = p;
  }
}
function match(texts: string[]): number[] {
  const last = texts.length - 1;
  const m = new Matcher(texts, texts[last]!.substring(0, 2), 1);
  if (m.pos < m.text(m.seg).length) m.add(m.seg, m.pos + 1);
  m.add(last, m.text(last).length);
  return m.found;
}
class Counter {
  n = 0;
  k = 2;
  log = "";
  bump(x: number): number { x = x * 2; this.n += x; return x; }
  clampTo(x: number, max = 10): number { if (x > max) x = max; this.n = x; return this.n; }
  pick(i: number): number { if (i > 1) { this.n = 7; } else { this.n = this.n + 1; } return this.n; }
  sum(): number { let s = 0; for (let i = 0; i < this.k; i++) { s += this.n; this.log += i; } return s; }
  guarded(t: boolean): string {
    try { if (t) throw new Error("boom"); this.log += "ok"; } catch (e) { this.log += "caught"; } finally { this.log += "!"; }
    return this.log;
  }
  twice(c: boolean): number { if (c) { this.bump(1); } else { this.pick(0); } return this.n; }
  label(): string { return this.n > 5 ? "big" : this.n > 0 ? "small" : "zero"; }
}
class Point {
  x: number;
  y: number;
  constructor(x?: number, y?: number) {
    if (x !== undefined) { this.x = x; } else { this.x = -1; }
    this.y = y === undefined ? -2 : y;
  }
  norm1(): number { let a = this.x; if (a < 0) a = -a; let b = this.y; if (b < 0) b = -b; return a + b; }
}
class Point3 extends Point {
  z: number;
  constructor(z: number) { super(z > 0 ? z : undefined); this.z = z; }
}
function main(): void {
  console.log(JSON.stringify(match(["abc"])), JSON.stringify(match(["xy", "left-right"])));
  const a = 5;
  let b = 3;
  const c = new Counter();
  const r = c.bump(a);
  const q = c.bump(b);
  console.log(a, b, r, q, c.n);
  const big = 40;
  console.log(c.clampTo(big), big, c.clampTo(4, 3), c.pick(2), c.pick(0), c.sum(), c.log);
  const d = new Counter();
  console.log(d.guarded(false), d.guarded(true), d.twice(true), d.twice(false), d.label());
  const e = new Counter();
  console.log(e.label(), e.pick(0), e.label());
  const p = new Point();
  const p2 = new Point(3);
  const p3 = new Point(-4, 5);
  console.log(p.x, p.y, p.norm1(), p2.x, p2.y, p3.norm1());
  const s = new Point3(2);
  const t = new Point3(-3);
  console.log(s.x, s.y, s.z, t.x, t.z, t.norm1());
  let total = 0;
  for (let i = 0; i < 4; i++) { const k = new Counter(); total += k.bump(i) + k.pick(i) + k.sum(); }
  console.log(total);
}
main();
export {};
