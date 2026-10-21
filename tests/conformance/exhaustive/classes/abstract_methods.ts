// An abstract method has no runtime existence: it is not a property of the
// class's prototype (garnet installed it there, bound to an unrelated
// function), and calls reach the subclasses' implementations.
abstract class Shape {
  abstract area(): number;
  abstract get label(): string;
  describe(): string { return `${this.label}=${this.area()}`; }
}
class Sq extends Shape {
  area(): number { return 4; }
  get label(): string { return "sq"; }
}
class Tri extends Shape {
  area(): number { return 3; }
  get label(): string { return "tri"; }
}
function main(): void {
  const proto = Shape.prototype as unknown as Record<string, unknown>;
  console.log("area" in Shape.prototype, Object.getOwnPropertyNames(Shape.prototype).sort().join(","), typeof proto.area);
  console.log(Object.getOwnPropertyNames(Sq.prototype).sort().join(","), [new Sq(), new Tri()].map((s) => s.describe()).join(" "));
}
main();
export {};
