function main(): void {
  // A subclass instance field shadows a parent prototype method (JS own->proto).
  class Base { greet(): number { return 2; } }
  class Derived extends Base { greet = (): number => 1; }
  const d = new Derived();
  console.log(d.greet());                 // 1 (field, not the inherited method)

  // No shadow: inherited method is used.
  class Plain extends Base { }
  console.log(new Plain().greet());        // 2

  // Field-typed method on its own class, shadowing an inherited method.
  class B2 { run(): number { return 10; } }
  class D2 extends B2 { run = (): number => 20; }
  console.log(new D2().run());             // 20
}
main();
