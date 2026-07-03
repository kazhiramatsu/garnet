export class Animal {
  constructor(public name: string, public legs: number) {}
  speak() { return this.name + " makes a sound"; }
  info() { return this.name + "/" + this.legs; }
}
