// Static accessors: `static get v()` / `static set v(x)`. Reading `C.v` invokes
// the static getter; writing `C.v = x` invokes the static setter; both also work
// via `this` inside static methods/accessors. The accessor body's `this` is the
// class's static container, so `this.otherStatic` and `this.staticMethod()` work.
// Inherited static getters resolve through the class chain. A static getter must
// NOT be confused with an instance getter of the same name.
class Box {
  static _v = 5;
  static get v(): number { return this._v; }       // static getter, reads static field via this
  static set v(x: number) { this._v = x; }          // static setter, writes static field via this
  static w = 4;
  static h = 3;
  static get area(): number { return this.w * this.h; } // computed getter over two statics
  static dbl(): number { return this._v * 2; }      // static method
  static get twice(): number { return this.dbl(); } // getter calling a static method via this
  static bump(): number { this.v = this.v + 10; return this.v; } // this.getter / this.setter
}

class Base {
  static _b = 7;
  static get tag(): number { return this._b; }      // static getter on a base class
}
class Derived extends Base {}                        // inherits the static getter

// A class with BOTH a static and an instance getter of the same name: they must
// resolve independently (static on the class, instance on the prototype).
class Dual {
  _v = 2;
  static _sv = 20;
  get v(): number { return this._v; }
  static get v(): number { return this._sv; }
}

function main(): void {
  console.log(Box.v);          // 5    (static getter)
  Box.v = 9;                   // static setter
  console.log(Box.v);          // 9
  console.log(Box.area);       // 12   (computed getter)
  console.log(Box.twice);      // 18   (getter -> static method)
  console.log(Box.bump());     // 19   (this.setter / this.getter inside a static method)
  console.log(Box.v);          // 19

  console.log(Derived.tag);    // 7    (inherited static getter)
  console.log(Base.tag);       // 7

  console.log(Dual.v);         // 20   (static getter on the class)
  console.log(new Dual().v);   // 2    (instance getter on the prototype)
}

main();
