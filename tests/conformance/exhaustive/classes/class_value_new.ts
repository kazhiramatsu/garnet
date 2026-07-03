// A class used as a VALUE, then instantiated via the variable: `const K = C; new K()`.
// Phase B resolves the classId from the new-expression's result type (the instance
// type) for capture-free / module classes. Phase A boxes a class as a runtime value
// carrying class_id + captured cells (a closure), so a factory `makeClass(z)` and a
// polymorphic `cond ? C : D` also construct correctly via ts_construct.
class Point {
  x: number; y: number;
  constructor(a: number, b: number) { this.x = a; this.y = b; }
  sum() { return this.x + this.y; }
}

class Animal { constructor() {} speak() { return "?"; } }
class Dog extends Animal { constructor() { super(); } speak() { return "woof"; } }

function makeCounter(start: number) {
  class Counter {
    n = start;
    constructor() {}
    inc() { this.n++; return this; }
    get() { return this.n; }
  }
  return Counter;
}

function main(): void {
  // Phase B: module class via a variable
  const K = Point;
  const p = new K(3, 4);
  console.log(p.x, p.y, p.sum());          // 3 4 7

  // method chain directly on `new K()` (return this)
  const o = new K(1, 2);
  console.log(o.sum());                     // 3

  // inheritance through a class value
  const D = Dog;
  console.log(new D().speak());             // woof

  // Phase A: factory capturing a function local
  const C1 = makeCounter(10);
  const C2 = makeCounter(100);
  console.log(new C1().get(), new C2().get());        // 10 100
  console.log(new C1().inc().inc().get());            // 12  (return-this chain on new K())

  // distinct factory instances are independent
  const Make = makeCounter(0);
  const a = new Make(); const b = new Make();
  a.inc(); a.inc(); b.inc();
  console.log(a.get(), b.get());            // 2 1

  // typeof a class value is "function"
  console.log(typeof K, typeof C1);         // function function

  // ctor args through a factory class value
  function scaled(factor: number) {
    class S { v: number; constructor(a: number) { this.v = a * factor; } }
    return S;
  }
  const Sc = scaled(3);
  console.log(new Sc(5).v);                 // 15

  // regression: ordinary `new C()` unchanged
  console.log(new Point(5, 6).sum());       // 11
  console.log(new Dog().speak());           // woof
}

main();
