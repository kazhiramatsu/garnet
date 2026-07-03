// `super.x = v` writes through super. Supported: a declared DATA field on an instance
// (own field on the receiver, skipping any same-class setter), a parent ACCESSOR
// setter on an instance (invoked with this = the receiver; SROA scalar-replaces it
// like super.method()), and STATIC super writes (own data field on the container, or
// the parent's static setter with this = the receiver class). The assignment yields
// the RHS. (getter-only members and undeclared properties are loud-rejected — see
// tests/rejects_syntax.sh.)

class A {
  x = 1;
  static sx = 10;
  static _sv = 0;
  static set sv(v: number) {
    A._sv = v + 1; // parent static setter; `this` is the receiver class
  }
  static get sv(): number {
    return A._sv;
  }
}

class B extends A {
  own = 0;
  // instance: write a declared field inherited from A through super (-> own on this)
  setInherited(v: number): number {
    super.x = v;
    return this.x;
  }
  // instance: write a field declared on B itself through super
  setOwn(v: number): number {
    super.own = v;
    return this.own;
  }
  // the assignment expression returns the RHS
  setReturn(): number {
    return (super.x = 8);
  }
  // static: write a parent static DATA field (own on the receiver class B)
  static setStaticData(v: number): void {
    super.sx = v;
  }
  // static: invoke the parent's static SETTER through super
  static setStaticSetter(v: number): void {
    super.sv = v;
  }
}

// instance: parent ACCESSOR setter via super (invoked with this = the receiver),
// including skipping the subclass's own override and resolving through a grandparent.
class P {
  _v = 0;
  set acc(v: number) {
    this._v = v * 2; // parent instance setter
  }
  get acc(): number {
    return this._v;
  }
}
class Q extends P {
  set acc(v: number) {
    this._v = v * 100; // overridden — super.acc must SKIP this and use P's
  }
  viaSuper(v: number): number {
    super.acc = v;
    return this._v;
  }
}
class R extends Q {
  // no own acc — super resolves to Q's? No: super from R is Q; Q has acc setter.
  viaSuper(v: number): number {
    super.acc = v; // Q.acc setter (v*100)
    return this._v;
  }
}

// static super through two levels (grandparent's static setter / data)
class C extends B {
  static setGrandSetter(v: number): void {
    super.sv = v; // resolves A.sv setter (inherited via B), this = C
  }
}

function main(): void {
  const b = new B();
  console.log(b.setInherited(5), b.x); // 5 5
  console.log(b.setOwn(7), b.own); // 7 7
  console.log(b.setReturn()); // 8  (and b.x is now 8)
  console.log(b.x); // 8

  B.setStaticData(99);
  console.log((B as any).sx, A.sx); // 99 10  (own on B, A unchanged)

  B.setStaticSetter(4);
  console.log(A.sv); // 5  (parent setter ran: A._sv = 4 + 1)

  C.setGrandSetter(9);
  console.log(A.sv); // 10  (grandparent setter via super: A._sv = 9 + 1)

  // instance parent accessor setter via super (skips Q's override -> uses P's v*2)
  const q = new Q();
  console.log(q.viaSuper(3)); // 6   (P.acc: 3 * 2)
  // and through a grandparent (R -> Q's acc setter: v*100)
  const r = new R();
  console.log(r.viaSuper(2)); // 200 (Q.acc: 2 * 100)

  // undeclared property via super -> own data on the receiver instance (no parent
  // setter), including when the only declaration is a setter on the current prototype.
  console.log(new Undecl().run()); // 3
  console.log(new ProtoSetter().run()); // 9 (own data, the prototype setter is skipped)
}

class Undecl {
  run(): unknown {
    super.foo = 3;
    return (this as any).foo; // 3 (own data property)
  }
}
class PSBase {}
class ProtoSetter extends PSBase {
  set x(v: number) {
    (this as any)._unused = v; // a setter on this class's prototype; A (base) has none
  }
  run(): unknown {
    super.x = 9; // -> own data on the instance, skipping this prototype's setter
    return (this as any).x;
  }
}

main();
