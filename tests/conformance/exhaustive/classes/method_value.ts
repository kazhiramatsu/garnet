// A class instance METHOD referenced as a VALUE (`c.m`, not called). It resolves
// the (unbound) prototype method, so `.bind`/`.call`/`.apply` work and it can be
// passed as a callback. (A bare detached call has this=undefined, like JS.)
class Calc {
  base: number;
  constructor(b: number) { this.base = b; }
  add(x: number) { return this.base + x; }
  double() { return this.base * 2; }
}

class Animal { sound() { return "?"; } }
class Dog extends Animal { sound() { return "woof"; } }

class Logger {
  prefix = "LOG:";
  log(m: string) { return this.prefix + m; }
  make() { return this.log.bind(this); }   // this.m.bind(this)
}

function main(): void {
  const c = new Calc(10);

  // bind / call / apply
  const add = c.add.bind(c);
  console.log(add(5));                          // 15
  console.log(c.add.call(c, 7));                // 17
  console.log(c.add.apply(c, [3]));             // 13
  console.log(c.double.bind(c)());              // 20

  // typeof a method value is "function"
  console.log(typeof c.add, typeof c.double);   // function function

  // inherited method as a value
  const b = new Dog();
  console.log(b.sound.bind(b)());               // woof
  const a = new Animal();
  console.log(a.sound.call(a));                 // ?

  // this.m.bind(this) inside a method, used later
  const f = new Logger().make();
  console.log(f("hi"));                         // LOG:hi

  // method bound and used as a callback
  const log2 = new Logger();
  console.log(["x", "y"].map(log2.log.bind(log2)).join(",")); // LOG:x,LOG:y

  // partial application via bind
  const add100 = new Calc(100).add.bind(new Calc(100));
  console.log(add100(1));                        // 101

  // ---- regressions ----
  // ordinary method calls + return-this chaining + field-arrow value
  console.log(c.add(1), c.double());             // 11 20
  class Chain { v = 1; inc() { this.v++; return this; } }
  console.log(new Chain().inc().inc().v);        // 3
  class WithArrow { v = 7; f = () => this.v; }
  const wa = new WithArrow();
  const g = wa.f;
  console.log(g());                              // 7  (arrow field keeps its bound this)
  // object-literal method as a value still works (field-key path)
  const o = { v: 5, get() { return this.v; } };
  console.log(typeof o.get);                     // function
}

main();
