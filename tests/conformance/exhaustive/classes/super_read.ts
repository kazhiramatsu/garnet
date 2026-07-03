// `super.x` READ on an instance does a [[Get]] on the PARENT prototype with
// this = the receiver: a parent getter is invoked (with this), a parent method
// yields its function value, and a DATA field reads as undefined (instance fields
// live on the instance, not the prototype) — as does a setter-only or absent member.
// `super.m()` calls and compound `super.x += v` (read via parent getter, write via
// parent setter) are exercised too.

class A {
  x = 1; // instance data field -> NOT visible via super
  _a = 42;
  foo(): number {
    return 9;
  }
  get g(): number {
    return 7;
  }
  get acc(): number {
    return this._a; // getter uses `this` = the receiver
  }
  set wo(v: number) {
    this._a = v; // setter-only: super.wo reads undefined
  }
}

class B extends A {
  readField(): unknown {
    return super.x; // undefined (data field not on the prototype)
  }
  methodType(): string {
    return typeof super.foo; // "function"
  }
  methodCall(): number {
    return super.foo() + 1; // 10  (call path)
  }
  getter(): number {
    return super.g; // 7
  }
  getterThis(): number {
    return super.acc; // 42 (this._a)
  }
  setterOnly(): unknown {
    return super.wo; // undefined (no getter half)
  }
  absent(): unknown {
    return (super as any).nope; // undefined
  }
}

// compound assignment through a super getter + setter
class P {
  _v = 10;
  get n(): number {
    return this._v;
  }
  set n(x: number) {
    this._v = x;
  }
}
class Q extends P {
  bump(): number {
    super.n += 5; // read 10 via P.n getter, write 15 via P.n setter
    return this._v;
  }
}

// grandparent getter via super
class GA {
  _w = 3;
  get gg(): number {
    return this._w * 2;
  }
}
class GB extends GA {}
class GC extends GB {
  read(): number {
    return super.gg; // 6  (resolved through the grandparent)
  }
}

function main(): void {
  const b = new B();
  console.log(b.readField()); // undefined
  console.log(b.methodType()); // function
  console.log(b.methodCall()); // 10
  console.log(b.getter()); // 7
  console.log(b.getterThis()); // 42
  console.log(b.setterOnly()); // undefined
  console.log(b.absent()); // undefined

  console.log(new Q().bump()); // 15
  console.log(new GC().read()); // 6
}

main();
