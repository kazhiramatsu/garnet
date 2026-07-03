class Shape {
  area(): number { return 0; }
  name(): string { return "shape"; }
}
class Square extends Shape {
  s: number;
  constructor(s: number) { super(); this.s = s; }
  area(): number { return this.s * this.s; }
  name(): string { return "square"; }
}
class Circle extends Shape {
  r: number;
  constructor(r: number) { super(); this.r = r; }
  area(): number { return 3 * this.r * this.r; }
}
function main(): void {
  // virtual dispatch through a base-class-typed variable.
  const s: Shape = new Circle(2);
  console.log(s.area());                       // 12

  // polymorphic dispatch over a mixed-type array.
  const shapes: Shape[] = [new Square(2), new Circle(3), new Shape()];
  let total = 0;
  for (const sh of shapes) total += sh.area();
  console.log(total);                          // 4 + 27 + 0 = 31

  // overridden vs inherited method on the same hierarchy.
  let names = "";
  for (const sh of shapes) names += sh.name() + ",";
  console.log(names);                          // square,shape,shape,
}
main();
