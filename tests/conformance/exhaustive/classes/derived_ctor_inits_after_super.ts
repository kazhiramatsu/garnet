// A derived class's field initializers and parameter properties run when its super() call
// returns, not at the top of its constructor: the base constructor sees them uninitialized (a
// method it calls reads undefined), a field the base constructor sets is overwritten by the
// derived initializer, an initializer reads what the base constructor set, and a derived
// `get [Symbol.toStringTag]` (installed per instance) replaces the base's, whichever statement
// calls super(). Node's own ordering is the oracle.
class A { x = 0; label = "base"; constructor() { this.x = 1; this.label = "set-by-A"; this.init(); } init(): void {} }
class B extends A {
  x = 2;
  name = "b";
  constructor(public z: number) { super(); console.log("after super", this.x, this.name, this.z, this.label); }
  init(): void { console.log("init sees", this.name, this.label); }
}
class C extends A { w = this.x + 10; constructor() { super(); } }
class T { get [Symbol.toStringTag](): string { return "T"; } }
class U extends T { constructor() { super(); } get [Symbol.toStringTag](): string { return "U"; } }
class V extends T { constructor(flag: boolean) { if (flag) { super(); } else { super(); } } get [Symbol.toStringTag](): string { return "V"; } }
class E extends Error { code = 7; constructor(m: string) { super(m); } }
function main(): void {
  const b = new B(9);
  console.log(b.x, b.name, b.z, b.label);
  console.log(new C().w);
  console.log(String(new U()), String(new V(true)), String(new V(false)), Object.prototype.toString.call(new U()));
  const e = new E("m");
  console.log(e.message, e.code, e instanceof E, e instanceof Error);
}
main();
