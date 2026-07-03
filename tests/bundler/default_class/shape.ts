export default class Shape {
  constructor(public sides: number) {}
  describe() { return "sides=" + this.sides; }
}
