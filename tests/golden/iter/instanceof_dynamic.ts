class Animal { name: string; constructor(n: string) { this.name = n; } }
class Dog extends Animal { bark(): string { return "woof"; } }
class Cat extends Animal { meow(): string { return "meow"; } }
function check(a: Animal): void {
  // `a` is statically Animal but may be a Dog/Cat at runtime -> dynamic instanceof
  console.log(a instanceof Dog);
  console.log(a instanceof Cat);
  console.log(a instanceof Animal);
}
function main(): void {
  const d: Animal = new Dog("Rex");
  const c: Animal = new Cat("Tom");
  check(d);    // true, false, true
  console.log("---");
  check(c);    // false, true, true
  // any-typed
  const x: any = new Dog("Fido");
  console.log(x instanceof Dog);     // true
  console.log(x instanceof Animal);  // true
  console.log(x instanceof Cat);     // false
}

main();
