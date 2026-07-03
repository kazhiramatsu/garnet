// Parent with field initializers but NO explicit constructor: super() must run
// the parent's implicit construction (field inits + parent chain).
class A { tag = "base"; n = 1; }
class B extends A { b = 2; constructor() { super(); } }
// Grandparent chain, each level adds a field.
class G1 { a = 1; }
class G2 extends G1 { b = 2; }
class G3 extends G2 { c = 3; constructor() { super(); } }
// super() with an argument forwarded to an arg-less implicit parent ctor.
class P {}
class Q extends P { x: number; constructor(x: number) { super(); this.x = x; } }
function main(): void {
  const b = new B();
  console.log(b.tag, b.n, b.b);                // base 1 2
  const g = new G3();
  console.log(g.a, g.b, g.c);                  // 1 2 3
  console.log(new Q(7).x);                     // 7
}
main();
