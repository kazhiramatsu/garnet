// `x instanceof C` where the right-hand side is a runtime constructor VALUE (a class
// held in a variable/parameter, or a `cond ? A : B` union), not a static class name.
// Works for every class shape (empty/field/ctor) now that a class-as-value is a
// proper ts_func carrying its class id: the runtime consults C[Symbol.hasInstance]
// then walks the prototype chain against C's prototype. (RHS whose static type is
// not a constructor — e.g. `any` — still loud-rejects; see tests/rejects_syntax.sh.)

class Animal {}
class Dog extends Animal {
  bark(): string {
    return "woof";
  }
}
class Cat extends Animal {}
class Pug extends Dog {}

class Fielded {
  kind = "f";
}

// a class whose static [Symbol.hasInstance] overrides the ordinary check
class EvenChecker {
  static [Symbol.hasInstance](x: unknown): boolean {
    return typeof x === "number" && x % 2 === 0;
  }
}

// the canonical generic helper: RHS is a constructor-typed parameter
function isInstance(x: unknown, C: typeof Animal): boolean {
  return x instanceof C;
}

function main(): void {
  // RHS via a constructor-typed parameter (subclass instance, miss, primitive)
  console.log(isInstance(new Dog(), Animal)); // true
  console.log(isInstance(new Cat(), Animal)); // true
  console.log(isInstance({}, Animal)); // false
  console.log(isInstance(5, Animal)); // false (primitive)

  // RHS via a local variable holding a class
  const A = Animal;
  console.log(new Dog() instanceof A, new Pug() instanceof A); // true true
  const D = Dog;
  console.log(new Pug() instanceof D, new Cat() instanceof D); // true false

  // RHS via a conditional (union of class values)
  const pickDog = true;
  const C1 = pickDog ? Dog : Cat;
  console.log(new Dog() instanceof C1, new Cat() instanceof C1); // true false

  // field-only class as a runtime RHS value
  const F = Fielded;
  console.log(new Fielded() instanceof F, ({} as any) instanceof F); // true false

  // Symbol.hasInstance hook honored on a runtime constructor value
  const H = EvenChecker;
  console.log(4 instanceof H, 3 instanceof H); // true false

  // a real subclass chain via a variable
  console.log(new Pug() instanceof Dog, new Pug() instanceof Animal); // true true (static RHS regression)
}

main();
