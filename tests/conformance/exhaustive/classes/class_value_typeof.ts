// A class used as a runtime VALUE (`const K = C`, passed as an argument, returned)
// is a proper first-class function value: `typeof` is "function" for EVERY class
// shape — empty, field-only, method-only, statics-only, and explicit-constructor —
// not "object"/"undefined". Static members still resolve through the value, and it
// can still be constructed.

class Empty {}
class Fielded {
  kind = "f";
  n = 1 + 2;
}
class Methoded {
  greet(): string {
    return "hi";
  }
}
class Statics {
  static tag = "s";
  static make(): number {
    return 42;
  }
}
class Ctored {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}

function kindOf(C: unknown): string {
  return typeof C;
}

function main(): void {
  // typeof of a class value -> "function" for every shape
  const E = Empty;
  const F = Fielded;
  const M = Methoded;
  const S = Statics;
  const C = Ctored;
  console.log(typeof E, typeof F, typeof M, typeof S, typeof C); // function x5

  // passed through a function (the value crosses a call boundary)
  console.log(kindOf(Empty), kindOf(Fielded), kindOf(Statics)); // function function function

  // statics still resolve through the value
  console.log(S.tag, S.make()); // s 42
  const S2 = Statics;
  console.log(S2.tag, S2.make()); // s 42

  // the value still constructs (field initializers run)
  const f: any = new F();
  console.log(f.kind, f.n); // f 3
  const inst = new C(7);
  console.log(inst.x); // 7

  // stored in an array, read back, typeof
  const arr: any[] = [Empty, Methoded];
  console.log(typeof arr[0], typeof arr[1]); // function function
}

main();
