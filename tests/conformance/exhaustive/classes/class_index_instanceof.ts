// `instanceof` of classes declared once answers by the instance's class
// index (an interval per class and its subclasses) while the prototype
// chains are the static ones: an instance whose prototype the program
// changes, objects made by Object.create, instances made through class
// values, classes extending library classes or qualified class names, and
// class prototypes relinked at run time keep JavaScript's prototype-chain
// answer.
class Animal { legs = 4; }
class Dog extends Animal { bark(): string { return "woof"; } }
class Puppy extends Dog { small = true; }
class Cat extends Animal { meow(): string { return "meow"; } }
class Rock { hard = true; }
class AppError extends Error { code = 7; }
namespace zoo { export class Bird extends Animal { wings = 2; } }
class Parrot extends zoo.Bird { talks = true; }

function tags(x: unknown): string {
  return [x instanceof Animal, x instanceof Dog, x instanceof Puppy, x instanceof Cat, x instanceof Rock]
    .map((b) => (b ? "1" : "0")).join("");
}

function main(): void {
  const a = new Animal(), d = new Dog(), p = new Puppy(), c = new Cat(), r = new Rock();
  console.log(tags(a), tags(d), tags(p), tags(c), tags(r), tags({}), tags(null), tags(3));
  // through a class value
  const ctors: (new () => Animal)[] = [Dog, Puppy, Cat];
  console.log(ctors.map((K) => tags(new K())).join(" "));
  // Object.create and a changed instance prototype
  const made = Object.create(Puppy.prototype) as Puppy;
  const moved = new Dog();
  Object.setPrototypeOf(moved, Cat.prototype);
  console.log(tags(made), tags(moved), moved instanceof Cat, (moved as unknown as Cat).meow());
  // library and expression bases
  const e = new AppError("x");
  const m = new Parrot();
  console.log(e instanceof AppError, e instanceof Error, m instanceof Parrot, m instanceof zoo.Bird, tags(m), m.legs, m.wings);
  // a class's prototype is an instance of its base class; relinking an
  // ordinary object (a dictionary) concerns no class
  const dict = Object.setPrototypeOf({ k: 1 }, null) as { k: number };
  console.log(Dog.prototype instanceof Animal, Puppy.prototype instanceof Dog, Animal.prototype instanceof Dog, dict.k, tags(d));
  // a class prototype relinked at run time
  Object.setPrototypeOf(Cat.prototype, Rock.prototype);
  const c2 = new Cat();
  console.log(tags(c), tags(c2), c2 instanceof Rock, c instanceof Animal);
  let n = 0;
  const xs: unknown[] = [a, d, p, c, r, made, moved, e, m];
  for (let i = 0; i < 2000; i++) for (const x of xs) if (x instanceof Dog) n++;
  console.log(n);
}
main();
export {};
