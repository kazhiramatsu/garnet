// Class EXPRESSIONS bound to a value (`const C = class { ... }`), anonymous and
// named, with fields/ctor/methods/getters/setters/statics/inheritance.
const Anon = class {
  x = 5;
  m(): number { return this.x * 2; }
};
const Named = class N {
  v(): number { return 7; }
};
const Point = class {
  constructor(public a: number, public b: number) {}
  sum(): number { return this.a + this.b; }
  get mag(): number { return this.a * this.a + this.b * this.b; }
};
const Acc = class {
  x = 1;
  get d(): number { return this.x * 2; }
  set d(v: number) { this.x = v; }
  static origin(): number { return 0; }
};
class Base { base(): number { return 100; } }
const Derived = class extends Base {
  extra(): number { return 1; }
};

function main(): void {
  const a = new Anon();
  console.log(a.x, a.m());                         // 5 10
  console.log(new Named().v());                    // 7
  const p = new Point(3, 4);
  console.log(p.sum(), p.mag);                     // 7 25
  const ac = new Acc();
  ac.d = 9;
  console.log(ac.x, ac.d, Acc.origin());           // 9 18 0
  const d = new Derived();
  console.log(d.base(), d.extra());                // 100 1
  // collection of class-expression instances + method dispatch
  const pts = [new Point(1, 2), new Point(2, 3)];
  console.log(pts.map((q) => q.sum()).join(","));  // 3,5
}
main();
