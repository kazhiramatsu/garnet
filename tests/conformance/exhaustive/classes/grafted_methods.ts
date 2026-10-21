// A class method that runs with a `this` of another class or of no class
// (docs/closed_receivers_design.md, slice 2): grafted onto another object,
// borrowed through call / apply / bind / Reflect.apply, called bare, or found
// through a relinked prototype. Its typed `this` accesses must read the
// receiver's own properties, as V8 does, not the struct offsets of the
// method's class; a sized instance relinked behind another class keeps its
// own fields; a getter moved by its descriptor reads its new holder.
class C {
  f = 1;
  g = 2;
  name = "c";
  get(): number { return this.g; }
  label(): string { return this.name; }
  sum(): number { return this.f + this.g; }
  get twice(): number { return this.g * 2; }
  relay(): string { return readName(this); }
}
// a typed parameter that a grafted method's foreign `this` is passed on to
function readName(c: C): string { return String(c.name); }
class D { a = 10; b = 20; c = 30; }
class E extends C {
  h = 5;
  override get(): number { return super.get() + this.h; }
}
function show(v: unknown): string { return v === undefined ? "undefined" : Number.isNaN(v) ? "NaN" : String(v); }
function main(): void {
  const d: any = new D();
  d.label = C.prototype.label;
  d.sum = C.prototype.sum;
  console.log(show(d.label()), show(d.sum()), d.a);
  d.relay = C.prototype.relay;
  console.log(d.relay(), new C().relay());
  const o: any = { g: 42, f: 1 };
  o.sum = C.prototype.sum;
  console.log(o.sum());
  console.log(C.prototype.get.call({ g: 7 }), show(C.prototype.sum.apply(new D() as any, [])), C.prototype.get.bind({ g: 9 })());
  console.log(Reflect.apply(C.prototype.sum, { f: 3, g: 4 }, []));
  const bare = new C().label;
  try { bare(); console.log("no throw"); } catch (e) { console.log((e as Error).constructor.name); }
  const e = new E();
  console.log(C.prototype.get.call(e), e.get(), [1].map(e.get, e)[0], e.twice);
  const r: any = new D();
  Object.setPrototypeOf(r, C.prototype);
  console.log(r instanceof C, show(r.label()), r.a, r.b, Object.keys(r).join(","), JSON.stringify(r));
  r.g = 6;
  console.log(r.get(), show(r.sum()), r.twice);
  const back: any = new C();
  Object.setPrototypeOf(back, E.prototype);
  console.log(back instanceof E, back.label(), back.f, show(back.h));
  const holder: any = { g: 11 };
  Object.defineProperty(holder, "twice", Object.getOwnPropertyDescriptor(C.prototype, "twice")!);
  console.log(holder.twice);
  const fresh = new C();
  console.log(fresh.get(), fresh.sum(), fresh.twice, new E().get());
}
main();
