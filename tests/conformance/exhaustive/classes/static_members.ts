// Static members: a static METHOD as a first-class VALUE (`const f = C.m`,
// `.bind`/`.call`/`.apply`, passed as a callback, `typeof`), and `this` inside a
// static method (bound to the class's static container, so `this.staticField`
// reads/writes the statics). (NB: a detached static method that reads `this`
// is a JS footgun — V8 throws — so those forms are not tested here.)
class MathU {
  static double(x: number) { return x * 2; }
  static add(a: number, b: number) { return a + b; }
}

class Counter {
  static count = 0;
  static next() { return ++this.count; }   // `this` -> static container
  static reset() { this.count = 0; }
  static get() { return this.count; }
}

class Greeter {
  static label = "hi";
  static greet() { return this.label + "!"; }
}

class Base { static make() { return "base"; } }
class Derived extends Base {}

class Point {
  constructor(public x: number, public y: number) {}
  static origin() { return new Point(0, 0); }
}

function main(): void {
  // static method as a value, then called
  const f = MathU.add;
  console.log(f(2, 3));                         // 5
  console.log(typeof MathU.double);            // function

  // bind / call / apply
  console.log(MathU.add.bind(null)(7, 8));     // 15
  console.log(MathU.add.call(null, 1, 2));     // 3
  console.log(MathU.add.apply(null, [4, 5]));  // 9

  // passed as a callback
  console.log([1, 2, 3, 4].map(MathU.double).join(",")); // 2,4,6,8
  console.log([1, 2, 3].map(MathU.double).filter(x => x > 2).join(",")); // 4,6

  // `this` inside a static method (read + write of static fields)
  console.log(Counter.next(), Counter.next(), Counter.next()); // 1 2 3
  console.log(Counter.get());                  // 3
  Counter.reset();
  console.log(Counter.get());                  // 0
  console.log(Greeter.greet());                // hi!
  Greeter.label = "yo";
  console.log(Greeter.greet());                // yo!

  // inherited static method (call + value)
  console.log(Derived.make());                 // base
  const g = Derived.make;
  console.log(g());                            // base

  // static factory used as a value
  const make = Point.origin;
  const p = make();
  console.log(p.x, p.y);                       // 0 0

  // ---- regressions ----
  console.log(MathU.add(10, 20));              // 30  (direct static call)
  console.log(Counter.count);                  // 0   (static field read after reset)
  class Inst { v = 5; m() { return this.v; } } // instance method + value
  const c = new Inst();
  console.log(c.m(), c.m.bind(c)());           // 5 5
}

main();
