interface Animal { name: string; legs: number; sound(): string; }
interface Dog extends Animal { breed: string; }
interface Sized { readonly size: number; tag?: string; }

class Cat implements Animal {
  name: string; legs: number;
  constructor(n: string) { this.name = n; this.legs = 4; }
  sound(): string { return "meow"; }
}

function describe(a: Animal): string { return a.name + ":" + a.legs + ":" + a.sound(); }

function main(): void {
  const d: Dog = { name: "Rex", legs: 4, breed: "lab", sound: () => "woof" };
  const c = new Cat("Tom");
  const s: Sized = { size: 10 };
  console.log(describe(d), d.breed);
  console.log(describe(c));
  console.log(s.size, s.tag ?? "none");
}
main();
