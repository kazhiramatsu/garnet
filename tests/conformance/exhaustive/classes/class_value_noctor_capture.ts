// A NO-CONSTRUCTOR class whose field initializers capture an enclosing function's
// locals, used as a first-class VALUE (`const K = C` / returned from a factory /
// chosen polymorphically). The synthesized class-value ctor (no explicit ctor) now
// threads the captured cells on the value's env, resolved at the value-creation site
// — so `new K()` reconstructs the captured state. Mirrors the explicit-ctor factory
// pattern, extended to no-ctor classes. (Cross-scope / parent-explicit-ctor capture
// stays a loud-reject — see tests/rejects_syntax.sh.)

// monomorphic: const K = A (A captures a function local in a field init)
function monoCapture(): string {
  const x = 42;
  class A {
    a = x;
    g(): number {
      return this.a * 2;
    }
  }
  const K = A;
  const o = new K();
  return `${o.a},${o.g()}`;
}

// multiple captures — env order must match between the synth ctor and the value site
function multiCapture(): string {
  const x = 3;
  const y = 5;
  class A {
    a = x;
    b = y;
    c = x + y;
  }
  const K = A;
  const o: any = new K();
  return [o.a, o.b, o.c].join(",");
}

// a module-scope ref (read via GLOBALS) mixed with a function-local capture (cell)
const G = 100;
function mixedCapture(): string {
  const x = 7;
  class A {
    g = G;
    l = x;
  }
  const K = A;
  const o: any = new K();
  return `${o.g},${o.l}`;
}

// factory returning a capturing no-ctor class; each call bakes its own captured value
function makeBox(v: number) {
  class Box {
    value = v;
    doubled(): number {
      return this.value * 2;
    }
  }
  return Box;
}

// polymorphic: const K = cond ? A : B, where a member is a no-ctor capturing class
function polyCapture(useA: boolean): string {
  const x = 9;
  class A {
    a = x;
    tag = "A";
  }
  class B {
    b = x + 1;
    tag = "B";
  }
  const K = useA ? A : B;
  const o: any = new K();
  return `${o.tag}:${useA ? o.a : o.b}`;
}

function main(): void {
  console.log(monoCapture()); // 42,84
  console.log(multiCapture()); // 3,5,8

  // fresh capture per call (cells resolved per value-creation site)
  const Box1 = makeBox(11);
  const Box2 = makeBox(22);
  const b1: any = new Box1();
  const b2: any = new Box2();
  console.log(b1.value, b1.doubled(), b2.value); // 11 22 22

  console.log(mixedCapture()); // 100,7
  console.log(polyCapture(true), polyCapture(false)); // A:9 B:10

  // loop site: each iteration's class value captures that iteration's local
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const x = i * 10;
    class A {
      a = x;
    }
    const K = A;
    out.push(new K().a);
  }
  console.log(out.join(",")); // 0,10,20
}

main();
