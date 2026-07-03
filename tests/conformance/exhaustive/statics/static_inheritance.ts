// Static fields are inherited by subclasses; an overriding subclass shadows the
// parent's static of the same name (each class keeps its own value).
class A {
  static x = 5;
  static label = "A";
}
class B extends A {
  static y = 10;
}
class C extends B {}

class M {
  static make(): number { return 42; }
  static add(a: number, b: number): number { return a + b; }
}
class N extends M {}

class P {
  static v = 1;
}
class Q extends P {
  static v = 2;          // shadows P.v
}

function main(): void {
  console.log(B.x, B.y, A.x);     // 5 10 5
  console.log(C.x);               // 5 (inherited two levels)
  console.log(B.label);           // A
  console.log(P.v, Q.v);          // 1 2 (override shadows, both distinct)
  console.log(N.make(), N.add(3, 4)); // 42 7 (inherited static methods)
}

main();
