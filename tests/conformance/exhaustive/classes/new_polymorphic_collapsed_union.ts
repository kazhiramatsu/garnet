// `new K()` where K is `cond ? A : B` and A and B are STRUCTURALLY IDENTICAL (same
// field shape) so TypeScript collapses the union `A | B` to a single static type.
// The runtime object can still be either class, and their methods may differ — so the
// constructed value is tainted "polymorphic" and every method call on it dispatches
// dynamically through the actual prototype (never devirtualized to one member). Field
// access is sound either way because the colliding classes share a layout.
//
// (Only intra-function use is supported: the polymorphic instance must not escape its
// constructing function — passing it to a call / returning / storing loud-rejects, so
// a downstream devirtualization can never silently miscompile. Distinct-shape unions
// don't collapse and may escape freely — see new_polymorphic_class_value.ts.)

class Cat {
  legs = 4;
  sound(): string {
    return "meow";
  }
}
class Fox {
  legs = 4; // SAME shape as Cat -> the union collapses to one static type
  sound(): string {
    return "ring-ding";
  }
}

// structurally identical, different field VALUES + different method
class Inc {
  base = 10;
  step(): number {
    return this.base + 1;
  }
}
class Dec {
  base = 10;
  step(): number {
    return this.base - 1;
  }
}

// structurally identical with differing GETTER and SETTER bodies
class Plus {
  _x = 0;
  get v(): number {
    return this._x + 1;
  }
  set v(n: number) {
    this._x = n;
  }
}
class Times {
  _x = 0;
  get v(): number {
    return this._x * 2;
  }
  set v(n: number) {
    this._x = n;
  }
}

function main(): void {
  // method dispatches dynamically per the actual runtime class
  for (const isCat of [true, false]) {
    const K = isCat ? Cat : Fox;
    const o = new K();
    console.log(o.sound(), o.legs); // meow 4 | ring-ding 4
  }

  // direct `new (cond ? A : B)()` form
  for (const up of [true, false]) {
    const o = new (up ? Inc : Dec)();
    console.log(o.step(), o.base); // 11 10 | 9 10
  }

  // alias through a copy: the alias is tainted too, still dynamic
  const useInc = false;
  const K = useInc ? Inc : Dec;
  const a = new K();
  const b = a;
  console.log(b.step()); // 9

  // getter / setter dispatch on a collapsed-poly value
  for (const plus of [true, false]) {
    const P = plus ? Plus : Times;
    const o = new P();
    o.v = 5; // both setters store 5 into _x
    console.log(o.v); // Plus: 6 | Times: 10
  }

  // instanceof on a collapsed-poly value must reflect the ACTUAL runtime class
  // (the static type collapsed to one member, so the answer can't be folded).
  for (const isCat of [true, false]) {
    const K2 = isCat ? Cat : Fox;
    const o = new K2();
    console.log(o instanceof Cat, o instanceof Fox); // true false | false true
  }
}

main();
