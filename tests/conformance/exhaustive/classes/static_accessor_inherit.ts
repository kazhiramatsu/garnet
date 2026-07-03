// Inherited static accessors are subclass-aware in `this`: when a static getter/
// setter declared on a base class is invoked via a subclass that shadows a static
// the accessor reads, `this` reflects the subclass's static view (matching JS,
// where `B.v` invokes A's static getter with this=B). Covers direct shadow,
// setter independence, computed getters, a transitive subclass with no own
// container, and an accessor that calls another inherited accessor via `this`.
class A {
  static _v = 1;
  static get v(): number { return this._v; }
  static set v(x: number) { this._v = x; }
  static w = 4;
  static h = 3;
  static get area(): number { return this.w * this.h; }
  static get vPlus(): number { return this.v + 100; } // getter that reads another getter via this
}

class B extends A {
  static _v = 99;  // shadows A._v
  static w = 10;   // shadows A.w
}

class C extends B {}  // no own statics: inherits B's shadowed view

function main(): void {
  // direct field shadow through an inherited getter
  console.log(A.v);       // 1
  console.log(B.v);       // 99

  // inherited setter writes the subclass's own static, leaving the base untouched
  B.v = 5;
  console.log(B.v);       // 5
  console.log(A.v);       // 1   (independent)

  // computed getter reads shadowed fields per receiver
  console.log(A.area);    // 12
  console.log(B.area);    // 30  (10 * 3)

  // a getter that calls another inherited getter via `this`
  console.log(A.vPlus);   // 101
  console.log(B.vPlus);   // 105 (B.v is now 5)

  // transitive: C has no own container; reads B's shadowed _v
  console.log(C.v);       // 5   (B._v after the write above)

  // ---- regressions ----
  console.log(A.h);       // 3   (plain inherited static field, unshadowed)
}

main();
