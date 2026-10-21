// A program with closed receivers (docs/closed_receivers_design.md): nothing
// in it can make a Proxy, relink an object behind a class prototype or call a
// class method with a foreign `this`, so its typed accesses drop the
// foreign-receiver test. The calls below are the ones that stay closed: a
// method bound to its own instance, a library function's call / apply, a
// sized instance as a thisArg, a prototype of null. Typed reads and writes
// through parameters, `this`, narrowed locals and casts must still match V8,
// and a null or undefined receiver must still throw V8's TypeError.
class Point {
  x: number;
  y: number;
  label: string;
  constructor(x: number, y: number, label: string) { this.x = x; this.y = y; this.label = label; }
  norm(): number { return Math.sqrt(this.x * this.x + this.y * this.y); }
  shift(dx: number): void { this.x += dx; }
  describe(): string { return `${this.label}(${this.x},${this.y})`; }
}
class Point3 extends Point {
  z = 0;
  constructor(x: number, y: number, z: number) { super(x, y, "p3"); this.z = z; }
  override describe(): string { return `${super.describe()}+${this.z}`; }
}
class Counter {
  count = 0;
  readonly bump: () => number;
  constructor() { this.bump = this.inc.bind(this); }
  inc(): number { return ++this.count; }
  addAll(values: number[]): number { values.forEach(this.addOne, this); return this.count; }
  addOne(v: number): void { this.count += v; }
}
function sumX(points: Point[]): number {
  let s = 0;
  for (const p of points) s += p.x;
  return s;
}
function readLabel(p: Point | undefined): string {
  try { return p!.label; } catch (e) { return (e as Error).constructor.name; }
}
function main(): void {
  const pts: Point[] = [new Point(3, 4, "a"), new Point3(1, 2, 2), new Point(0, -1, "c")];
  console.log(sumX(pts), pts.map((p) => p.norm().toFixed(3)).join(" "));
  pts[0].shift(2);
  pts[1].y = 7;
  console.log(pts.map((p) => p.describe()).join(" "));
  for (const p of pts) if (p instanceof Point3) console.log("p3", p.z, (p as Point3).z + p.x);
  const c = new Counter();
  console.log(c.bump(), c.bump(), c.addAll([1, 2, 3]), c.count);
  console.log(Math.max.apply(null, [4, 9, 2]), Object.prototype.hasOwnProperty.call(pts[0], "x"),
    Array.prototype.slice.call([1, 2, 3], 1).join(","));
  const bare = Object.create(null) as Record<string, number>;
  bare.k = 1;
  const relinked = Object.setPrototypeOf({ v: 2 }, null) as { v: number };
  console.log(Object.keys(bare).join(","), relinked.v, Object.getPrototypeOf(relinked));
  console.log(readLabel(pts[2]), readLabel(undefined));
  const maybe: (Point | null)[] = [pts[0], null];
  for (const m of maybe) {
    try { console.log(m!.x); } catch (e) { console.log((e as Error).constructor.name, String((e as Error).message).includes("null")); }
  }
}
main();
