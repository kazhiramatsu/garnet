class Animal {
  name: string;
  constructor(n: string) { this.name = n; }
  speak(): string { return this.name + " makes a sound"; }
}
class Dog extends Animal {
  speak(): string { return this.name + " barks"; }
}
function main(): void {
  const a = new Animal("Generic");
  const d = new Dog("Rex");
  console.log(a.speak(), d.speak());
}

main();
