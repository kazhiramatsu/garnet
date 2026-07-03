// Static methods are real first-class functions whose `this` is the runtime
// receiver: `.call`/`.apply`/`.bind` honor the thisArg (a plain object, an
// instance, or another class to "borrow" the method for), and a static method
// invoked normally binds `this` to its class object. Static members live on a
// proto-linked container, so `this.x`/`this.m()` resolve via the runtime chain.
class Calc {
  static base = 10;
  static addBase(n: number): number { return this.base + n; }      // reads this.base
  static combine(a: number, b: number): number { return this.base + a + b; }
  static pure(a: number, b: number): number { return a + b; }       // ignores this
}

// A different class with the same shape — used as a borrow target for Calc.addBase.
class Other {
  static base = 1000;
}

class Box { base = 50; }   // a plain instance carrying `base`

function main(): void {
  // .call / .apply / .bind with an explicit thisArg = the class itself
  console.log(Calc.addBase.call(Calc, 5));        // 15
  console.log(Calc.combine.apply(Calc, [2, 3]));  // 15
  const bound = Calc.addBase.bind(Calc);
  console.log(bound(7));                           // 17

  // borrow: run Calc.addBase with this = Other (reads Other.base)
  console.log(Calc.addBase.call(Other, 5));       // 1005
  console.log(Calc.addBase.bind(Other)(1));       // 1001

  // thisArg = a plain object / an instance (reads that object's `base`)
  console.log(Calc.addBase.call({ base: 100 }, 1)); // 101
  console.log(Calc.addBase.apply(new Box(), [3]));  // 53

  // this-less static method via apply(null) (common reduce/callback shape)
  console.log(Calc.pure.apply(null, [4, 5]));     // 9
  console.log([1, 2, 3].map(Calc.pure.bind(Calc, 10)).join(",")); // 11,12,13 (partial-applied a=10)

  // static method as a plain callback (this=undefined, element -> first param)
  console.log([1, 2, 3, 4].map(Calc.pure.bind(null, 0)).join(",")); // 1,2,3,4

  // indirect bind through a stored value
  const f = Calc.combine;
  console.log(f.call(Calc, 4, 6));                // 20

  // class value carries statics (cc = C; cc.m())
  const K = Calc;
  console.log(K.base);                            // 10
  console.log(K.addBase.call(K, 2));              // 12
}

main();
