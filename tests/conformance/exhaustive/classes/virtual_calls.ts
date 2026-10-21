// Calls of methods several classes of a hierarchy implement (an abstract
// method, overrides) dispatch on the receiver's own class: through a base
// class, from the base's own methods (`this.visit(...)`), with numeric and
// boxed parameters, on receivers that are not instances (structural values,
// a changed prototype), and on a hierarchy whose implementations disagree on
// their parameters' representation.
abstract class Shape {
  constructor(readonly name: string) {}
  abstract area(scale: number): number;
  describe(): string { return `${this.name}:${this.area(1).toFixed(2)}`; }
  twice(scale: number): number { return this.area(scale) * 2; }
}
class Square extends Shape {
  constructor(readonly side: number) { super("square"); }
  area(scale: number): number { return this.side * this.side * scale; }
}
class Circle extends Shape {
  constructor(readonly r: number) { super("circle"); }
  area(scale: number): number { return Math.PI * this.r * this.r * scale; }
}
class Ring extends Circle {
  constructor(r: number, readonly inner: number) { super(r); }
  area(scale: number): number { return super.area(scale) - Math.PI * this.inner * this.inner * scale; }
}
abstract class Visitor {
  count = 0;
  abstract visit(node: Shape): string;
  visitAll(nodes: Shape[]): string { let out = ""; for (const n of nodes) { out += this.visit(n) + ";"; this.count++; } return out; }
}
class NameVisitor extends Visitor { visit(node: Shape): string { return node.name; } }
class AreaVisitor extends Visitor { visit(node: Shape): string { return String(Math.round(node.area(10))); } }
class Tagger { tag(x: unknown): string { return "t:" + String(x); } }
class LoudTagger extends Tagger { tag(x: unknown): string { return "T:" + String(x) + "!"; } }
class NumTagger extends Tagger { tag(x: number): string { return "n:" + (x + 1); } }

function main(): void {
  const shapes: Shape[] = [new Square(2), new Circle(1), new Ring(2, 1)];
  console.log(shapes.map((s) => s.describe()).join(" "), shapes.map((s) => s.twice(3).toFixed(1)).join(" "));
  const visitors: Visitor[] = [new NameVisitor(), new AreaVisitor()];
  for (const v of visitors) console.log(v.visitAll(shapes), v.count);
  const fake = { tag: (x: unknown) => "fake:" + String(x) } as unknown as Tagger;
  const moved = new LoudTagger();
  Object.setPrototypeOf(moved, Tagger.prototype);
  console.log([fake, moved].map((t) => t.tag(1)).join(" "), moved instanceof LoudTagger);
  const taggers: Tagger[] = [new Tagger(), new LoudTagger(), new NumTagger()];
  console.log(taggers.map((t) => t.tag(41)).join(" "), taggers.slice(0, 2).map((t) => t.tag("ab")).join(" "));
  let total = 0;
  for (let i = 0; i < 20000; i++) for (const s of shapes) total += s.area(1);
  console.log(total.toFixed(3));
}
main();
export {};
