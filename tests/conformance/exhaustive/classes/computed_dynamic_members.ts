// Dynamic-keyed and symbol-keyed computed class members (no static literal key).
// These have no compile-time key, so they are installed at runtime as own
// data properties (string/numeric key) or symbol-keyed properties on the
// instance. Supported on classes WITHOUT an explicit constructor; methods are
// plain (non-generator, non-async). Called via `c[k]()` / `c[sym]()` (which
// binds `this`) or via `c.name()` when the key happens to equal a name.
const mk = "scale";
const sym = Symbol("tag");
const FACTOR = 100;   // module-scope const captured by an explicit-ctor class below

class Box {
  base = 10;
  [mk](n: number): number { return this.base * n; }   // dynamic-string method
  [sym] = 99;                                          // symbol-keyed field
  ["lit"] = 1;                                         // literal computed field (session 47)
}

class Derived extends Box {
  extra(): number { return 5; }                        // inheritance, no explicit ctor
}

// §89: an explicit constructor + a dynamic member / field initializer that
// capture only MODULE-scope bindings now work (the binding is published as a
// module cell and read via LoadGlobal inside the constructor).
class WithCtor {
  off = FACTOR;                          // field init captures module const
  v: number;
  constructor(x: number) { this.v = x; }
  [mk](n: number): number { return this.v + n + FACTOR; }  // dynamic key + body captures FACTOR
}

function main(): void {
  const b: any = new Box();
  console.log(b[mk](3));        // 30 — `this` bound to the receiver
  console.log(b.scale(4));      // 40 — same method via its resolved name
  console.log(b[sym]);          // 99 — symbol-keyed field
  console.log(b.lit);           // 1

  const d: any = new Derived();
  console.log(d[mk](2));        // 20 — inherited dynamic method
  console.log(d.extra());       // 5

  // dynamic key computed from a value
  const key = "v" + "1";
  class Pt { [key] = 7; }
  const p: any = new Pt();
  console.log(p.v1, p[key]);    // 7 7

  // explicit ctor + module-scope captures
  const w: any = new WithCtor(5);
  console.log(w.off);           // 100 — field init captured module const
  console.log(w.v);             // 5
  console.log(w[mk](2));        // 107 — dynamic method body captured FACTOR

  // §90: factory function — a class declared inside a function, with an explicit
  // constructor, whose field initializer / dynamic-keyed method capture that
  // function's locals. The cells are threaded into the Direct-called constructor.
  function makeBox(seed: number, key: string) {
    class Local {
      base = seed;                       // field init captures `seed`
      constructor(extra: number) { this.base = seed + extra; }
      [key](n: number): number { return this.base * n + seed; } // dynamic key + body capture
    }
    return new Local(1);
  }
  const lb: any = makeBox(10, "scaled");
  console.log(lb.base);          // 11  (seed 10 + extra 1)
  console.log(lb.scaled(2));     // 32  (11*2 + 10)
  const lb2: any = makeBox(100, "scaled");
  console.log(lb2.base, lb2.scaled(1)); // 101 201  (independent capture per call)

  // factory + inheritance via super(), parent captures the local
  function makePair(n: number) {
    class Base { v = n; constructor() {} }
    class Sub extends Base { w = 2; constructor() { super(); } }
    return new Sub();
  }
  const sp: any = makePair(7);
  console.log(sp.v, sp.w);       // 7 2
}

main();
