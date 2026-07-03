class Animal {
  constructor(public name: string, protected energy: number) {}
  describe(): string { return this.name; }
}
class Dog extends Animal {
  constructor(name: string) { super(name, 10); }
  get tired(): boolean { return this.energy < 3; }
  set boost(v: number) { this.energy = this.energy + v; }
  routine(): void {
    const wasTired = this.tired;   // getter call on this (Dog)
    this.boost = 5;                // setter call on this
  }
}
function use(dd: Dog): boolean { dd.boost = 2; return dd.tired; }  // getter/setter on typed receiver
const realDog = new Dog("rex");
realDog.routine();
