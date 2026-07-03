class A { a = 1; b = 2; }
class B { x = 10; y = this.x + 5; }
class C { n: number; m = 3; constructor(n: number){ this.n = n; } }
class Base { p = 100; constructor(){ this.p = this.p + 1; } }
class Derived extends Base { q = 200; constructor(){ super(); this.q = this.q + 2; } }
class D2 extends Base { r = 5; }
function main(): void {
  const a = new A(); console.log(a.a, a.b);
  const b = new B(); console.log(b.x, b.y);
  const c = new C(7); console.log(c.n, c.m);
  const d = new Derived(); console.log(d.p, d.q);
  const d2 = new D2(); console.log(d2.p, d2.r);
}

main();
