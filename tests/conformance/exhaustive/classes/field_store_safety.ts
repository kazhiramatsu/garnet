// Typed class fields under the store-safety rule: a class whose methods
// downcast `this` keeps its numeric fields typed; a field stored through a
// cast stays a boxed value and holds whatever JS gives it; a class stored into
// dynamically keeps every field boxed; deletion and destructuring targets.
enum Flags { None = 0, A = 1, B = 2, C = 4 }
class Base {
  flags: Flags;
  id: number;
  extra: string | undefined;
  constructor(flags: Flags, id: number) { this.flags = flags; this.id = id; this.extra = undefined; }
  target(): number { return (this.flags & Flags.A) !== 0 ? (this as unknown as Sub).value : -1; }
  hasB(): boolean { return (this.flags & Flags.B) !== 0; }
}
class Sub extends Base {
  value: number;
  constructor(id: number, value: number) { super(Flags.A, id); this.value = value; }
}
class Loose {
  n: number = 1;
  m: number = 2;
  set(v: unknown) { this.n = v as number; }   // a store through a cast: n stays a boxed value
  bump() { this.m += 1; }
}
class Dyn {
  x: number = 10;
  y: number = 20;
}
class Del {
  p: number = 5;
  q: number = 6;
}
function main() {
  const out: unknown[] = [];
  const s = new Sub(7, 42);
  const b = new Base(Flags.B | Flags.C, 8);
  out.push(s.target(), b.target(), s.hasB(), b.hasB(), s.flags, b.flags, s.id + b.id, s.extra);
  for (let i = 0; i < 1000; i++) { s.flags = (s.flags ^ Flags.C) as Flags; b.id += 1; }
  out.push(s.flags, b.id, s.target(), typeof s.flags);
  const l = new Loose();
  l.set(7); l.bump();
  out.push(l.n, typeof l.n, l.m, l.n + l.m);
  l.set(3.5); out.push(l.n * 2);
  const d = new Dyn();
  (d as unknown as Record<string, unknown>)["x"] = 11;
  (d as unknown as Record<string, unknown>)["z"] = true;
  out.push(d.x, typeof d.x, d.y, Object.keys(d).join(","), (d as unknown as Record<string, unknown>)["z"]);
  const d2 = new Dyn();
  Object.assign(d2, { y: 21, w: 1 });
  out.push(d2.x, d2.y, typeof d2.y, Object.keys(d2).join(","));
  const e = new Del();
  delete (e as Partial<Del>).p;
  out.push(e.p, "p" in e, e.q, Object.keys(e).join(","));
  let t = { p: 0, q: 0 };
  const e2 = new Del();
  ({ p: e2.p, q: e2.q } = { p: 11, q: 12 });
  [e2.p, e2.q] = [e2.q, e2.p];
  out.push(e2.p, e2.q, t.p);
  console.log(JSON.stringify(out));
}
main();
