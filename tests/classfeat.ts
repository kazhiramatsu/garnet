class Animal {
  constructor(public name: string, protected energy: number) {}  // parameter properties
  describe(): string { return this.name; }
  move(): void { this.energy = this.energy - 1; }
}
class Dog extends Animal {
  constructor(name: string) { super(name, 10); }
  describe(): string { return "dog:" + super.describe(); }        // super.m()
  get tired(): boolean { return this.energy < 3; }                // getter
  set boost(v: number) { this.energy = this.energy + v; }         // setter
}
const d = new Dog("rex");
const t = d.tired;       // getter call
d.boost = 5;             // setter call
const s = d.describe();  // method call (super inside)
