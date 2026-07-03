// Reflect static reflection namespace — thin wrappers over the dynamic
// property / call / construct runtime. Methods that the spec defines as
// returning a boolean (set/deleteProperty/defineProperty/setPrototypeOf/
// preventExtensions) do so; get/getOwnPropertyDescriptor/ownKeys/apply/
// construct/getPrototypeOf return values/objects.
class Base {
  m(): number { return 1; }
}
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

function main(): void {
  // get / set / has / deleteProperty
  const o: any = { a: 1, b: 2 };
  console.log(Reflect.get(o, "a"));
  console.log(Reflect.set(o, "c", 3), o.c);     // true 3
  console.log(Reflect.has(o, "b"), Reflect.has(o, "z")); // true false
  console.log(Reflect.deleteProperty(o, "a"), Reflect.has(o, "a")); // true false
  console.log(Reflect.deleteProperty(o, "zzz")); // true (absent)

  // get with explicit receiver arg (ignored for plain data props)
  console.log(Reflect.get(o, "b", o)); // 2

  // ownKeys: string keys + symbols
  const s = Symbol("s");
  const k: any = { a: 1, b: 2 };
  k[s] = 9;
  console.log(Reflect.ownKeys(k).length); // 3
  console.log(Reflect.ownKeys({ x: 1, y: 2 }).join(",")); // x,y
  console.log(Reflect.ownKeys([10, 20]).join(",")); // 0,1,length

  // getPrototypeOf / setPrototypeOf
  const b = new Base();
  console.log(Reflect.getPrototypeOf(b) === Base.prototype); // true
  const t: any = {};
  const proto: any = { greet: 42 };
  console.log(Reflect.setPrototypeOf(t, proto), t.greet); // true 42

  // defineProperty / getOwnPropertyDescriptor
  const d: any = {};
  console.log(Reflect.defineProperty(d, "v", { value: 7, enumerable: true, writable: true, configurable: true }), d.v); // true 7
  const desc: any = Reflect.getOwnPropertyDescriptor(d, "v");
  console.log(desc.value, desc.enumerable, desc.writable);
  console.log(Reflect.getOwnPropertyDescriptor({ a: 1 }, "missing")); // undefined

  // isExtensible / preventExtensions
  const e: any = {};
  console.log(Reflect.isExtensible(e)); // true
  console.log(Reflect.preventExtensions(e)); // true
  console.log(Reflect.isExtensible(e)); // false

  // apply
  function add(a: number, b: number, c: number): number { return a + b + c; }
  console.log(Reflect.apply(add, null, [1, 2, 3])); // 6
  console.log(Reflect.apply(Math.max, null, [4, 9, 2])); // 9

  // construct
  const p: Point = Reflect.construct(Point, [3, 4]);
  console.log(p.x, p.y, p instanceof Point); // 3 4 true

  // has against inherited (prototype) method
  console.log(Reflect.has(b, "m")); // true
}
main();
