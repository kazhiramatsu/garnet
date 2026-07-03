// Inside a static method, `this.X` resolves to the class's STATIC members:
// a sibling static method call (`this.helper()`), a static method as a value
// (`const m = this.f`), and a static field read (incl. inherited from a parent).
// Writing an OWN static field via `this` works; writing an INHERITED one is a JS
// shadowing-own-property case that is loud-rejected (not tested here).
class Calc {
  static base = 10;
  static factor = 3;
  static raw() { return this.base + this.factor; }       // this.staticField read
  static scaled() { return this.raw() * 2; }             // this.staticMethod() call
  static deep() { return this.scaled() + this.base; }    // nested this.method() + field
  static viaValue(x: number) { const f = this.identity; return f(x); } // this.method as value
  static identity(x: number) { return x; }
  static setBase(v: number) { this.base = v; }           // this.ownStaticField write
}

class Base { static label = "base"; }
class Sub extends Base {
  static who() { return this.label; }                    // inherited static field via this
}

function main(): void {
  console.log(Calc.raw());        // 13
  console.log(Calc.scaled());     // 26
  console.log(Calc.deep());       // 36
  console.log(Calc.viaValue(7));  // 7

  // write an own static field via this, then read it back
  Calc.setBase(100);
  console.log(Calc.raw());        // 103
  console.log(Calc.base);         // 100  (also visible via ClassName)

  // inherited static field read via this
  console.log(Sub.who());         // base

  // ---- regressions ----
  console.log(Calc.identity(5));  // 5   (direct static call)
  const f = Calc.identity;        // static method (no `this`) as a value
  console.log(f(9));              // 9
  console.log([1, 2, 3].map(Calc.identity).join(",")); // 1,2,3  (callback)
}

main();
