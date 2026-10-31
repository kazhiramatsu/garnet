// for..in over objects whose prototype chain adds no key (the walk's keys are the object's own
// enumerable string keys) and over chains that do (inherited keys, shadowing, keys added to
// Object.prototype, Array.prototype and a class's prototype while the program runs).
class Point {
  x = 1;
  y = 2;
  norm(): number { return this.x + this.y; }
  get len(): number { return 3; }
}
class Point3 extends Point {
  w = 4;
}

function keysOf(o: any): string {
  const out: string[] = [];
  for (const k in o) out.push(k);
  return out.join(",");
}

function main(): void {
  // insertion order, integer-like keys first
  const a: any = { b: 1, a: 2, 10: "x", 2: "y", c: undefined };
  console.log(keysOf(a));
  Object.defineProperty(a, "hidden", { value: 1, enumerable: false });
  console.log(keysOf(a));
  const g: any = { get v() { return 1; }, w: 2 };
  console.log(keysOf(g));
  const s = Symbol("s");
  const withSym: any = { [s]: 1, k: 2 };
  console.log(keysOf(withSym));
  const n = Object.create(null);
  n.q = 1;
  n.p = 2;
  console.log(keysOf(n));
  console.log(keysOf(Object.create(null)));
  console.log(keysOf({}));

  // class instances: their fields, not the prototype's methods and accessors
  console.log(keysOf(new Point()));
  console.log(keysOf(new Point3()));
  const p: any = new Point();
  p.extra = 5;
  console.log(keysOf(p));

  // arrays: indices (holes skipped), then named properties
  const arr: any = [1, , 3];
  arr.extra = "e";
  console.log(keysOf(arr));
  console.log(keysOf([]));
  console.log(keysOf(["a", "b"]));

  // after a delete
  const d: any = { a: 1, b: 2, c: 3 };
  delete d.b;
  d.e = 5;
  console.log(keysOf(d));

  // a prototype with enumerable keys: own keys, then the inherited ones not shadowed
  const proto: any = { inherited: 1, shared: 2 };
  const child: any = Object.create(proto);
  child.own = 3;
  child.shared = 4;
  console.log(keysOf(child));
  const shadow: any = Object.create(proto);
  Object.defineProperty(shadow, "inherited", { value: 0, enumerable: false });
  console.log(keysOf(shadow));
  const oc = Object.create({ base: 1 }, { own: { value: 2, enumerable: true }, hide: { value: 3, enumerable: false } });
  console.log(keysOf(oc));
  const deep: any = Object.create(Object.create({ far: 1 }));
  deep.near = 2;
  console.log(keysOf(deep));
  // a prototype whose only properties are not enumerable
  const quiet = Object.create(null);
  Object.defineProperty(quiet, "q", { value: 1, enumerable: false });
  const overQuiet: any = Object.create(quiet);
  overQuiet.mine = 1;
  console.log(keysOf(overQuiet));
  // an array as a prototype: its indices are inherited keys
  const arrProto: any = Object.create(["p0", "p1"]);
  arrProto.own = 1;
  console.log(keysOf(arrProto));

  // keys added to the shared prototypes appear in every walk until deleted
  (Object.prototype as any).polluted = 1;
  console.log(keysOf({ z: 1 }));
  console.log(keysOf([7]));
  console.log(keysOf(new Point()));
  delete (Object.prototype as any).polluted;
  console.log(keysOf({ z: 1 }));
  (Array.prototype as any).arrExtra = 1;
  console.log(keysOf([7]));
  delete (Array.prototype as any).arrExtra;
  console.log(keysOf([7]));
  (Point.prototype as any).protoField = 9;
  console.log(keysOf(new Point3()));
  delete (Point.prototype as any).protoField;
  console.log(keysOf(new Point3()));

  // the same object walked many times
  const opts: any = { a: 1, b: 2, c: 3, d: 4 };
  let total = 0;
  for (let i = 0; i < 2000; i++) for (const k in opts) total += opts[k];
  console.log(total);
  // keys added during the walk are not visited
  const grow: any = { a: 1, b: 2 };
  const seen: string[] = [];
  for (const k in grow) {
    seen.push(k);
    grow[k + "2"] = 0;
  }
  console.log(seen.join(","), Object.keys(grow).join(","));
}

main();
