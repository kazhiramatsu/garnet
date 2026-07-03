// Polymorphic `new K(...args)` (K = cond ? A : B) where a union member has NO explicit
// constructor. The shared synthesized class-value ctor now handles the arguments like
// JS's implicit constructor:
//   - no explicit-ctor ancestor  -> the args are dropped (`constructor(){}`)
//   - an explicit-ctor parent    -> forwarded as `super(...args)` (CallSpread)
// (Distinct shapes keep the union from collapsing so it stays a polymorphic value.
// Only a no-ctor member whose parent ctor captures a function local stays rejected —
// see tests/rejects_syntax.sh.)

// ①A: no-ctor members with NO parent -> args ignored
class Plain1 {
  a = 1;
}
class Plain2 {
  b = 2;
}

// ①B: no-ctor members extending an explicit-ctor parent -> super(x) forwarding
class Base {
  v: number;
  constructor(x: number) {
    this.v = x;
  }
}
class Left extends Base {
  tag = "L";
}
class Right extends Base {
  mark = "R";
}

// ①B with multiple ctor args + own field initializers
class Pair {
  a: number;
  b: number;
  constructor(x: number, y: number) {
    this.a = x;
    this.b = y;
  }
}
class Sum extends Pair {
  kind = "sum";
}
class Diff extends Pair {
  kind = "diff";
}

// ①B forwarding through a no-ctor INTERMEDIATE class
class Held {
  v: number;
  constructor(x: number) {
    this.v = x;
  }
}
class Mid extends Held {
  m = 1;
}
class CC extends Mid {
  c = 10;
}
class DD extends Mid {
  d = 20;
}

function main(): void {
  // ①A: the 5 is ignored (implicit no-arg ctor)
  for (const first of [true, false]) {
    const K = first ? Plain1 : Plain2;
    const o: any = new K(5);
    console.log(first ? o.a : o.b); // 1 | 2
  }

  // ①B: arg forwarded to the parent ctor; own field initializer also runs
  for (const left of [true, false]) {
    const K = left ? Left : Right;
    const o: any = new K(7);
    console.log(o.v, left ? o.tag : o.mark); // 7 L | 7 R
  }

  // ①B: two args forwarded
  for (const isSum of [true, false]) {
    const K = isSum ? Sum : Diff;
    const o: any = new K(3, 4);
    console.log(o.a, o.b, o.kind); // 3 4 sum | 3 4 diff
  }

  // ①B: forward through a no-ctor intermediate, all field inits run
  for (const isC of [true, false]) {
    const K = isC ? CC : DD;
    const o: any = new K(8);
    console.log(o.v, o.m, isC ? o.c : o.d); // 8 1 10 | 8 1 20
  }

  // ①B: the parent ctor itself CAPTURES an enclosing function local (z), and the arg
  // is forwarded alongside the captured cell (super(x), ctor reads x + z).
  function withCapture(c: boolean, z: number): string {
    class CapBase {
      v: number;
      constructor(x: number) {
        this.v = x + z;
      }
    }
    class CapL extends CapBase {
      tag = "l";
    }
    class CapR extends CapBase {
      tag = "r";
    }
    const K = c ? CapL : CapR;
    const o: any = new K(5);
    return `${o.v}:${o.tag}`;
  }
  console.log(withCapture(true, 100), withCapture(false, 200)); // 105:l 205:r

  // ①B: child field-init capture (w) AND parent ctor capture (z) together — the env
  // must carry both cells in agreed order.
  function bothCaptures(c: boolean, z: number, w: number): string {
    class BothBase {
      v: number;
      constructor(x: number) {
        this.v = x + z;
      }
    }
    class BothL extends BothBase {
      e = w;
    }
    class BothR extends BothBase {
      e = w * 2;
    }
    const K = c ? BothL : BothR;
    const o: any = new K(1);
    return `${o.v}:${o.e}`;
  }
  console.log(bothCaptures(true, 10, 3), bothCaptures(false, 10, 3)); // 11:3 11:6
}

main();
