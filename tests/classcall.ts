class Shape {
  id: number;
  constructor(id: number) { this.id = id; }
  area(): number { return 0; }
}
class Circle extends Shape {
  radius: number;
  constructor(r: number) { super(r); this.radius = r; }
  area(): number { return 3.14 * this.radius * this.radius; }
}
class Square extends Shape {
  side: number;
  constructor(s: number) { super(s); this.side = s; }
  area(): number { return this.side * this.side; }
}
function totalArea(shapes: Shape[]): number {
  let t = 0;
  for (const s of shapes) t = t + s.area();   // polymorphic method call -> Method callee
  return t;
}
const c = new Circle(2);
const a = c.area();                            // receiver statically Circle -> Method (mono)
