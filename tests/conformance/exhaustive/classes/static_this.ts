// `this` inside static members is the class value, as in JS: `new this(...)` in a static factory (yaml's
// `Collection.from`: `new this(schema)`), also when the factory is inherited and called on a subclass or
// through a variable holding the class; `this.name`, `this === C`, `this.prototype`; a static getter
// using `this` (the singleton idiom `this._inst ??= new this()`); a static setter; a static block and
// static field initializers reading `this`; an inherited static counter bumped through `this` writes the
// subclass's own static (the parent's stays); a static method detached as a callback runs with `this`
// undefined (`new this` throws a TypeError); `typeof this`.
class Shape {
  static count = 0;
  static registry = new Map<string, typeof Shape>();
  static tag = "shape:" + this.name;
  static { this.registry.set(this.name, this); }
  constructor(public size: number) {}
  static make(size: number): Shape { return new this(size); }
  static bump(): number { return ++this.count; }
  static describe(): string { return this.name + "/" + (this === Shape) + "/" + typeof this + "/" + (typeof this.prototype.area === "function"); }
  static get instance(): Shape { return (this._inst ??= new this(1)); }
  static set label(v: string) { this.tag = v + ":" + this.name; }
  static _inst: Shape | undefined;
  area(): number { return this.size * this.size; }
}
class Circle extends Shape {
  static { this.registry.set("circle", this); }
  area(): number { return 3 * this.size * this.size; }
}
function main(): void {
  const out: string[] = [];
  const a = Shape.make(2), c = Circle.make(3);
  out.push(a.constructor.name, String(a instanceof Shape), c.constructor.name, String(c instanceof Circle), String(c.area()));
  const M: typeof Shape = Circle;
  out.push(M.make(4).constructor.name, String(M.make(4) instanceof Circle));
  out.push(Shape.describe(), Circle.describe());
  out.push(Shape.instance.constructor.name, String(Shape.instance === Shape.instance), Circle.instance.constructor.name, String(Circle.instance !== Shape.instance), String(Circle.instance.area()));
  out.push(String(Shape.bump()), String(Circle.bump()), String(Circle.bump()), String(Shape.count), String(Circle.count), String(Object.hasOwn(Circle, "count")));
  out.push(Shape.tag, Circle.tag);
  Circle.label = "round";
  out.push(Shape.tag, Circle.tag);
  out.push(String(Shape.registry.get("Shape") === Shape), String(Shape.registry.get("circle") === Circle), String(Circle.registry === Shape.registry), String(Shape.registry.size));
  const detached = Shape.make;
  let threw = "";
  try { detached(5); } catch (e) { threw = (e as Error).constructor.name; }
  out.push(threw);
  const bound = Shape.make.bind(Circle);
  out.push(bound(6).constructor.name, (Shape.make.call(Circle, 7) as Shape).constructor.name);
  console.log(out.join("\n"));
}
main();
