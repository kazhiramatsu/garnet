// @ts-nocheck
// `super` inside arrows: reads, calls, writes, in methods, field initializers and static methods.
class A { m() { return "A.m:" + this.v; } get g() { return "A.g"; } static s() { return "A.s"; } v = 1; }
class B extends A {
  m() { const f = () => super.m(); const h = () => () => super.g; return f() + h()(); }
  q = () => super.m();
  static s() { const f = () => super.s(); return f(); }
  w() { const set = () => { super.v = 5; }; set(); return this.v; }
}
const b = new B();
console.log(b.m(), b.q(), B.s(), b.w());
