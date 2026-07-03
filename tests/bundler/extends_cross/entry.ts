import { Animal } from "./base";
class Dog extends Animal {
  constructor(name: string) { super(name, 4); }
  speak() { return this.name + " barks (" + super.speak() + ")"; }
}
const d = new Dog("Rex");
console.log(d.speak());
console.log(d.info());
console.log(d instanceof Animal, d instanceof Dog);
