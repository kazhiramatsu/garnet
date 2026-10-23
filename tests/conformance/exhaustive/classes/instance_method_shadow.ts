// An instance's own property shadowing a class method: assigned with the
// static type, through a cast of the instance, through a computed key and by
// defineProperty (a write through an alias of no known class, `const d = x as
// any; d.m = f`, on a single-implementation method is a documented gap);
// the call through a base-typed receiver, through the subclass type and
// through `any`; deleting the own property restores the method; a shadow on
// one instance leaves the others alone; hasOwnProperty and the prototype
// method stay reachable.
class Shape {
  area(k: number): number { return k; }
  name(): string { return "shape"; }
}
class Sq extends Shape {
  constructor(public s: number) { super(); }
  area(k: number): number { return this.s * this.s * k; }
  name(): string { return "sq"; }
}
class Ci extends Shape {
  constructor(public r: number) { super(); }
  area(k: number): number { return 3 * this.r * this.r * k; }
}
function total(shapes: Shape[], k: number): number {
  let acc = 0;
  for (const sh of shapes) acc += sh.area(k);
  return acc;
}
function main() {
  const out: unknown[] = [];
  const sq = new Sq(2), ci = new Ci(1), plain = new Shape(), other = new Sq(3);
  const shapes: Shape[] = [sq, ci, plain, other];
  out.push(total(shapes, 2));
  sq.area = (k: number) => 1000 + k;
  out.push(total(shapes, 1), sq.area(5), other.area(1), Object.prototype.hasOwnProperty.call(sq, "area"), Object.prototype.hasOwnProperty.call(other, "area"));
  (ci as any).area = function (this: Ci, k: number) { return -this.r * k; };
  const dyn = ci as any;
  out.push(total(shapes, 1), dyn.area(2), ci.area(3));
  const key = "na" + "me";
  (plain as any)[key] = () => "plain-own";
  out.push(plain.name(), sq.name(), (plain as any).name(), shapes.map((s) => s.name()).join(","));
  Object.defineProperty(other, "area", { value: (k: number) => 7 * k, configurable: true, writable: true });
  out.push(total(shapes, 1), other.area(2));
  delete (sq as any).area;
  delete (other as any).area;
  out.push(total(shapes, 1), sq.area(1), other.area(1), Object.prototype.hasOwnProperty.call(sq, "area"));
  out.push(Shape.prototype.area.call(sq, 4), Sq.prototype.area.call(sq, 1));
  // a plain object literal typed as the class (structural typing)
  const fake: Shape = { area: (k: number) => 42 * k, name: () => "fake" };
  out.push(total([fake, sq], 1), fake.name(), shapes.concat([fake]).map((s) => s.name()).join(","));
  // a plain object typed as a class whose method has one implementation
  class Rect { constructor(public w: number, public h: number) {} size(): number { return this.w * this.h; } }
  const r1 = new Rect(2, 3);
  const fakeRect: Rect = { w: 10, h: 10, size: () => -1 };
  const rects: Rect[] = [r1, fakeRect];
  out.push(r1.size(), fakeRect.size(), rects.map((r) => r.size()).join(","));
  (r1 as any).size = () => 77;
  out.push(r1.size(), rects.map((r) => r.size()).join(","));
  console.log(JSON.stringify(out));
}
main();
