// `super` inside a static method/accessor resolves to the parent class's static
// member: `super.m()` calls the parent's static method with this=the current
// receiver (so the parent method's `this.X` sees the subclass's static view);
// `super.field` reads the parent's static (not the subclass's shadow); a static
// `super.getter` runs the parent getter with this=the current receiver.
class A {
  static label = "A";
  static _v = 1;
  static greet(): string { return "A:" + this.label; }   // reads this.label
  static get tag(): number { return this._v; }            // reads this._v
}

class B extends A {
  static label = "B";      // shadows A.label
  static _v = 2;           // shadows A._v
  static greet(): string { return super.greet() + "|B:" + this.label; } // super method
  static get tag(): number { return super.tag + 100; }    // super getter (this=B -> B._v)
  static parentLabel(): string { return super.label; }    // super static field read (A's)
}

class C extends B {
  static greet(): string { return super.greet() + "|C"; } // 3-level super chain
}

function main(): void {
  // super.method() runs the parent's static method with this = the receiver,
  // so this.label inside A.greet reflects the subclass.
  console.log(A.greet());        // A:A
  console.log(B.greet());        // A:B|B:B   (super.greet() -> A.greet with this=B -> "A:B")
  console.log(C.greet());        // A:B|B:B|C (chain: C -> B -> A, this=C... B.label, A reads this.label=B)

  // super static field read = the PARENT's value, not the subclass shadow
  console.log(B.parentLabel());  // A

  // super static getter runs the parent getter with this = the receiver
  console.log(B.tag);            // 102  (super.tag -> A.tag with this=B -> B._v=2 -> +100)
  console.log(A.tag);            // 1
}

main();
