// A generic class cloned for an instantiation with number fields (`Box<number>` as `Box$number` under the
// strict profile) whose instance reaches the generic class's methods: through a receiver whose provenance
// the exporter cannot prove (`b.self().get()`), a method with type parameters of its own (`map`), a
// callback, a subclass. The generic method reads and writes the number field through its own struct, where
// the clone holds a raw double: representation 0 read the same bits by luck, representation 1 read another
// number (docs/unmasked_pointers_design.md, Session 369).
class Box<T> {
  constructor(public v: T) {}
  get(): T { return this.v; }
  set(x: T): this { this.v = x; return this; }
  self(): this { return this; }
}
class Cnt<T> {
  n = 0;
  constructor(public tag: T) {}
  bump(): this { this.n = this.n + 1; return this; }
  count(): number { return this.n; }
}
class Wrap<T> {
  constructor(public v: T) {}
  map<U>(f: (t: T) => U): Wrap<U> { return new Wrap(f(this.v)); }
  get(): T { return this.v; }
}
class Sub<T> extends Box<T> { twice(): T { return this.self().get(); } }
function main(): void {
  const b = new Box(5);
  b.v = 7;
  console.log(b.self().self().get(), b.self().set(2.5).get(), b.v);
  const c = new Cnt(1.5);
  console.log(c.bump().bump().count(), c.bump().tag, c.n);
  const ws = [new Wrap(1), new Wrap(2.5)];
  console.log(ws.map((w) => w.map((x) => x + 10).get()).join(","));
  const s = new Sub(3);
  console.log(s.twice(), s.self().set(-0.5).get(), s.v);
  const pick = (k: Box<number>) => k.get() * 2;
  console.log(pick(b), pick(s), [b, s].map((k) => k.self().get()).join(","));
}
main();
