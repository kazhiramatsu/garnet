function main(): void {
  // arrow captures the enclosing method's `this` (object literal method).
  const o = { v: 42, get(): number { return (() => this.v)(); } };
  console.log(o.get());                       // 42

  // arrow captures `this` in a class method (IIFE).
  class C { v = 7; get(): number { return (() => this.v)(); } }
  console.log(new C().get());                  // 7

  // nested arrows both see the class `this`.
  class D { v = 9; m(): number { const f = () => () => this.v; return f()(); } }
  console.log(new D().m());                    // 9

  // arrow returned from a method and called later still has the right `this`.
  class E { v = 100; mk(): () => number { return () => this.v; } }
  console.log(new E().mk()());                 // 100

  // arrow `this` inside a higher-order array method.
  class F { vals = [1, 2, 3]; mul = 10; go(): number[] { return this.vals.map((x) => x * this.mul); } }
  console.log(new F().go().join(","));         // 10,20,30
}
main();
