// Symbol-keyed INSTANCE class members: accessors keyed by a well-known symbol
// (Symbol.toStringTag) or a user symbol install per-instance as real accessor
// descriptors, so `obj[sym]` get/set invokes them and an instance
// [Symbol.toStringTag] getter is consulted by String(obj)/`${obj}` for free.
// Plain methods/fields with such keys (already supported) are exercised too, plus
// a dynamic-STRING-keyed instance accessor. Works with both implicit and explicit
// constructors.

const valSym = Symbol("val");
const dynKey = "prop";

class Widget {
  _v = 1;
  data = 100;

  // user-symbol accessor with a backing store.
  get [valSym](): number {
    return this._v;
  }
  set [valSym](x: number) {
    this._v = x * 2;
  }

  // well-known: consulted by String(obj) / `${obj}` for free.
  get [Symbol.toStringTag](): string {
    return "Widget";
  }

  // user-symbol plain method (already supported, exercised for completeness).
  [Symbol.iterator](): Iterator<number> {
    let i = 0;
    const self = this;
    return {
      next: () => (i < 2 ? { value: i++ === 0 ? self._v : self.data, done: false } : { value: undefined as any, done: true }),
    };
  }

  // dynamic-string-keyed instance accessor.
  get [dynKey](): number {
    return this.data;
  }
  set [dynKey](v: number) {
    this.data = v;
  }
}

// explicit constructor variant (install happens inside the ctor body).
const gSym = Symbol("g");
class WithCtor {
  _n: number;
  constructor(n: number) {
    this._n = n;
  }
  get [gSym](): number {
    return this._n * 10;
  }
}

function main(): void {
  const w = new Widget();

  // user-symbol get/set accessor
  console.log((w as any)[valSym]); // 1
  (w as any)[valSym] = 8;
  console.log((w as any)[valSym]); // 16  (setter doubled)
  console.log(w._v); // 16

  // well-known instance [Symbol.toStringTag] via String/template
  console.log(String(w)); // [object Widget]
  console.log(`${w}`); // [object Widget]

  // dynamic-string instance accessor
  console.log((w as any)["prop"]); // 100
  (w as any)["prop"] = 55;
  console.log((w as any)["prop"]); // 55

  // explicit-ctor instance symbol getter
  const c = new WithCtor(4);
  console.log((c as any)[gSym]); // 40
}

main();
