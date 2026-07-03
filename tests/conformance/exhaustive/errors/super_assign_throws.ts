// `super.x = v` throws a TypeError where JS's [[Set]] returns false: writing through
// a getter-only accessor (instance or static), and (static) when the receiver class
// has its own setter the parent lacks (the receiver's own accessor blocks the data
// write). We catch and check `e.name` ("TypeError") and that `e.message` is a string
// — the exact message text isn't asserted (it differs from V8's wording).

class A {
  get x(): number {
    return 1; // getter only, no setter
  }
  static get sx(): number {
    return 2; // static getter only
  }
}
class B extends A {
  write(): string {
    try {
      super.x = 5;
      return "no-throw";
    } catch (e: any) {
      return e.name + ":" + typeof e.message;
    }
  }
  static writeStatic(): string {
    try {
      super.sx = 5;
      return "no-throw";
    } catch (e: any) {
      return e.name;
    }
  }
}

// static: the subclass defines its OWN static setter that the parent lacks; `super.y`
// targets the parent (no setter) but the receiver's own accessor blocks -> throws.
class P {}
class Q extends P {
  static _v = 0;
  static set y(v: number) {
    Q._v = v;
  }
  static write(): string {
    try {
      super.y = 7;
      return "no-throw";
    } catch (e: any) {
      return e.name;
    }
  }
}

function main(): void {
  console.log(new B().write()); // TypeError:string
  console.log(B.writeStatic()); // TypeError
  console.log(Q.write()); // TypeError
  // the throw is catchable and control continues normally afterward
  let after = 0;
  try {
    const b = new B();
    b.write(); // returns (catches internally)
    after = 1;
  } catch {
    after = -1;
  }
  console.log(after); // 1
}

main();
