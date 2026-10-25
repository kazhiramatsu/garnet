// Store-proven integer fields (docs/int32_fields_design.md): `number` class fields whose
// every store is an integer (positions, ids, counters) become integer slots; a field with
// one fractional store stays a double; captured variables of number type become typed
// context fields (closure counters, module-level counters, an enum-typed variable, a loop
// variable, a parameter); values flow between proven fields, through parameters, through
// `| 0`, and in both directions of the range (negative, beyond 2^31, 2^40).
enum Kind { None = 0, Leaf = 1, Pair = 2 }
let nextId = 0;
let kindSeen = Kind.None;
let total = 0;
class Nd {
  pos = 0; end = -1; id = 0; weight = 0; kind = Kind.None;
  constructor(pos: number, end: number) { this.pos = pos; this.end = end; }
}
class Pair extends Nd {
  left: Nd; right: Nd;
  constructor(l: Nd, r: Nd) { super(l.pos, r.end); this.left = l; this.right = r; this.kind = Kind.Pair; }
}
function idOf(n: Nd): number { if (!n.id) { nextId++; n.id = nextId; } return n.id; }
function span(n: Nd): number { return n.end - n.pos; }
function shift(n: Nd, by: number): void { n.pos = n.pos + by; n.end = (n.end + by) | 0; }
function weigh(n: Nd, w: number): void { n.weight = w; }   // a fractional store: weight stays a double
function makeCounter(start: number): () => number { let c = start; return () => { c += 3; total += c; return c; }; }
function main(): void {
  const a = new Nd(10, 20), b = new Nd(30, 2147483648), c = new Nd(-5, 1099511627776);
  const p = new Pair(a, b);
  kindSeen = p.kind;
  shift(a, 7); shift(c, -1);
  weigh(a, 0.5); weigh(b, 2);
  console.log(a.pos, a.end, span(a), b.end, c.pos, c.end, span(c), p.pos, p.end, span(p));
  console.log(idOf(b), idOf(a), idOf(b), idOf(p), nextId, kindSeen, Kind[kindSeen]);
  console.log(a.weight, b.weight, a.weight + b.weight);
  const counters: (() => number)[] = [];
  for (let i = 0; i < 3; i++) { const k = makeCounter(counters.length * 100); counters.push(k); counters.push(() => i + k()); }
  let s = 0; for (const f of counters) s += f();
  console.log(s, total);
  const g = makeCounter(2147483646);
  console.log(g(), g(), total);
  const m: Nd[] = []; for (let i = 0; i < 4; i++) m.push(new Nd(i, i * 2));
  let acc = 0; for (const n of m) { acc += span(n) * 10 + idOf(n); }
  console.log(acc, nextId, m.map((n) => n.end - n.pos).join(","));
  const o = JSON.parse('{"pos": 3}') as { pos: number };
  const d = new Nd(o.pos | 0, (o.pos + 4) | 0);   // JSON numbers enter as int32
  console.log(d.pos, d.end, span(d), String(d.id), typeof d.weight);
}
main();
