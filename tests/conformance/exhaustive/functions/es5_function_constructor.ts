// ES5 function constructors: `new Foo()` on a plain function runs [[Construct]]
// (fresh object chained to Foo.prototype, this-bound call, return-override).
// Module-scope declarations are boxed once (singleton), so Foo.prototype is one
// stable object across `Foo.prototype.m = ...` sites and construction sites —
// methods added before AND after an instance exist are both visible through the
// shared prototype. Natural ES5 bodies read `this` without declaring a `this`
// parameter; the exporter gives them the same args[0] this slot.
function Counter(start: number) {
  (this as any).n = start;
}
(Counter.prototype as any).inc = function () { return ++(this as any).n; };

function Animal(this: any, name: string) { this.name = name; }
(Animal.prototype as any).speak = function (this: any) { return this.name + " speaks"; };
(Animal.prototype as any).toString = function (this: any) { return "<" + this.name + ">"; };

function Obj(this: any) { this.a = 1; return { b: 2 } as any; }
function Prim(this: any) { this.a = 3; return 42 as any; }

function make(n: number) {
  function Inner(this: any) { this.n = n; }
  (Inner.prototype as any).get = function (this: any) { return this.n; };
  const i: any = new Inner();
  return { C: Inner as any, i };
}

function probe() { return typeof (this as any); }

function main(): void {
  // construction, args, own fields, no-parens form
  const c: any = new Counter(10);
  console.log(c.n, c.inc(), c.inc(), c.n);
  const c2: any = new Counter(0);
  console.log(c2.n, c === c2);

  // prototype methods added before/after creation; shared identity
  const a: any = new Animal("Rex");
  (Animal.prototype as any).late = function (this: any) { return this.name + "!"; };
  const b: any = new Animal("Mia");
  console.log(a.speak(), b.speak());
  console.log(a.late(), b.late());
  console.log(a.speak === b.speak);

  // prototype toString shadows Object.prototype's in string coercion
  console.log("" + a, String(b), `${a}`);

  // instanceof: plain-function RHS walks fn.prototype
  console.log(a instanceof Animal, c instanceof Animal, a instanceof Counter);

  // constructor backref + fn metadata via the instance
  console.log(a.constructor === Animal, a.constructor.name, a.constructor.length);

  // return-override (via any-typed callee): object return wins, primitive ignored
  const O: any = Obj;
  const o: any = new O();
  console.log(o.a, o.b);
  const P: any = Prim;
  console.log(new P().a);

  // nested declarations: fresh function object (and prototype) per invocation
  const m1 = make(1), m2 = make(2);
  console.log(m1.i.get(), m2.i.get());
  console.log(m1.C === m2.C, m1.i instanceof m1.C, m1.i instanceof m2.C);

  // dynamic `this` in a plain function: strict-mode undefined on bare/callback
  // calls, the receiver on method calls, injected by .call
  console.log(probe());
  console.log([1].map(probe)[0]);
  const holder: any = { probe };
  console.log(holder.probe());
  console.log(probe.call(42));
}
main();
