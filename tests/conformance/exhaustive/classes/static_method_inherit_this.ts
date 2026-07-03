// Inherited static methods are subclass-aware in `this`: when a static method
// declared on a base class is invoked via a subclass (`B.m()`), `this` reflects
// the subclass's static view, so reading a shadowed static field, calling an
// inherited getter, or calling an overridden static method via `this` all resolve
// against the subclass (matching JS, where B.m() runs A's method with this=B).
// (Detached value calls like `const f = B.m; f()` throw in JS — strict-mode
// `this=undefined` — so they are not exercised here.)
class A {
  static _v = 1;
  static get v(): number { return this._v; }       // inherited getter read via this
  static show(): number { return this._v; }         // reads a (shadowable) static field
  static showV(): number { return this.v; }          // method -> inherited getter
  static b(): number { return 10; }
  static a(): number { return this.b() + 1; }        // method -> overridable static method
}

class B extends A {
  static _v = 7;        // shadows A._v
  static b(): number { return 20; }  // overrides A.b
}

class C extends B {}    // no own statics: inherits B's shadowed view (transitive)

function main(): void {
  // direct field shadow via an inherited method
  console.log(A.show());  // 1
  console.log(B.show());  // 7

  // method -> inherited getter, subclass-aware
  console.log(A.showV()); // 1
  console.log(B.showV()); // 7

  // method -> overridden static method via this
  console.log(A.a());     // 11
  console.log(B.a());     // 21  (this.b() -> B.b)

  // transitive: C has no own container; reads B's shadowed view
  console.log(C.show());  // 7
  console.log(C.a());     // 21

  // ---- regressions ----
  console.log(A.v);       // 1   (static getter still fine)
  console.log(B.v);       // 7
}

main();
