// `static [Symbol.hasInstance](x)` overrides `x instanceof C`: instanceof calls
// the hook with `this` = the class and ToBooleans the result, bypassing the
// ordinary prototype-chain walk entirely. The hook is inherited via the
// proto-linked static container chain (a subclass without its own hook uses the
// base class's). Works for any LHS value (objects, primitives), and overrides
// even the case where the proto walk would say true.

class EvenChecker {
  static [Symbol.hasInstance](x: any): boolean {
    return typeof x === "number" && x % 2 === 0;
  }
}

// hook reads class state via `this`/the class name.
class Tagged {
  static tag = "T";
  static [Symbol.hasInstance](x: any): boolean {
    return x != null && x.kind === Tagged.tag;
  }
}

// hook that returns false even for real instances (overrides the proto walk).
class Never {
  static [Symbol.hasInstance](_x: any): boolean {
    return false;
  }
}

// inheritance: Sub has no own hook, so `x instanceof Sub` uses Base's hook.
class Base {
  static [Symbol.hasInstance](x: any): boolean {
    return x === 42;
  }
}
class Sub extends Base {}

// a normal class (no hook) keeps the ordinary instanceof semantics.
class Plain {}
class PlainSub extends Plain {}

function main(): void {
  // numeric predicate hook, various LHS
  console.log(4 instanceof EvenChecker); // true
  console.log(5 instanceof EvenChecker); // false
  console.log("x" instanceof EvenChecker); // false
  console.log(({}) instanceof EvenChecker); // false

  // hook reading class state
  console.log(({ kind: "T" }) instanceof Tagged); // true
  console.log(({ kind: "Z" }) instanceof Tagged); // false

  // hook overrides the proto walk even for a genuine instance
  const n = new Never();
  console.log(n instanceof Never); // false

  // inherited hook
  console.log(42 instanceof Sub); // true
  console.log(43 instanceof Sub); // false
  console.log(42 instanceof Base); // true

  // no-hook class: ordinary prototype-chain instanceof still works
  const ps = new PlainSub();
  console.log(ps instanceof Plain); // true
  console.log(ps instanceof PlainSub); // true
  console.log(({}) instanceof Plain); // false
}

main();
