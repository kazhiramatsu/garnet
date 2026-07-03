// `new K()` where K is a POLYMORPHIC class value — a union of classes selected at
// runtime (`const K = cond ? A : B`, or directly `new (cond ? A : B)()`). The class
// is chosen at runtime, so construction dispatches dynamically on the value's class
// id, and the result (static type `A | B`) is accessed through the dynamic path
// (field reads + method calls resolve per the actual runtime class). Works for
// every class shape whose union doesn't collapse: distinct-shape classes and
// subclasses of a common base. (Passing ctor args is allowed only when every union
// member has an explicit constructor — see tests/rejects_syntax.sh.)

class Dog {
  legs = 4;
  speak(): string {
    return "woof";
  }
}
class Bird {
  wings = 2;
  speak(): string {
    return "tweet";
  }
}

// subclasses of a common base (override + inherited method)
class Shape {
  name(): string {
    return "shape";
  }
  area(): number {
    return 0;
  }
}
class Circle extends Shape {
  r = 2;
  area(): number {
    return 3 * this.r * this.r;
  }
}
class Square extends Shape {
  s = 3;
  area(): number {
    return this.s * this.s;
  }
}

// union members with explicit ctors taking an arg (args may be forwarded)
class Pos {
  v: number;
  tag = "p"; // distinct shape from Neg so the union doesn't collapse
  constructor(x: number) {
    this.v = x;
  }
}
class Neg {
  v: number;
  mark = "n";
  constructor(x: number) {
    this.v = -x;
  }
}

function makeAnimal(dog: boolean): Dog | Bird {
  const K = dog ? Dog : Bird;
  return new K();
}

function main(): void {
  // distinct-shape union via a variable: dynamic field + method
  const a1: any = makeAnimal(true);
  const a2: any = makeAnimal(false);
  console.log(a1.speak(), a1.legs); // woof 4
  console.log(a2.speak(), a2.wings); // tweet 2

  // directly `new (cond ? A : B)()` (annotate `: boolean` so it stays a union and
  // isn't narrowed to one branch)
  const flag: boolean = true;
  const a3: any = new (flag ? Dog : Bird)();
  console.log(a3.speak(), typeof a3); // woof object

  // instanceof on a polymorphic result
  console.log(makeAnimal(true) instanceof Dog, makeAnimal(false) instanceof Dog); // true false

  // subclasses of a common base: overridden method dispatches dynamically
  for (const isCircle of [true, false]) {
    const K = isCircle ? Circle : Square;
    const sh = new K();
    console.log(sh.name(), sh.area()); // shape 12 | shape 9
  }

  // polymorphic new with explicit-ctor members + a forwarded argument
  for (const pos of [true, false]) {
    const K = pos ? Pos : Neg;
    console.log(new K(5).v); // 5 | -5
  }
}

main();
