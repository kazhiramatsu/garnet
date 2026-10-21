// TypeScript types classes structurally: an object literal, an instance of
// an unrelated class, an interface-typed or `any` value can be typed as a
// class without private members, and a cast claims any type. Such a value
// read through the class type (a parameter, a return, an element, a generic
// constrained by the class, an upcast or a downcast of it, a type guard) is
// still the value itself: its own properties and its own methods. These read
// another field's slot (the literal's keys in another order) and ran the
// class's method instead of the value's.
class P {
  x = 1;
  y = 2;
  m(): number { return this.x * 100 + this.y; }
  base(): number { return this.x + this.y; }
}
class Sub extends P {
  z = 3;
  m(): number { return this.z; }
}
class Other { y = 20; x = 10; m(): number { return -1; } base(): number { return -2; } }
interface PLike { x: number; y: number; m(): number; base(): number }
class Nominal { #secret = 5; v = 7; read(): number { return this.v + this.#secret; } }

// callees that the optimizer does not inline (loops)
function readX(p: P): number { let s = 0; for (let i = 0; i < 2; i++) if (i === 1) s += p.x; return s; }
function readY(p: P): number { let s = 0; for (let i = 0; i < 2; i++) if (i === 0) s += p.y; return s; }
function callM(p: P): number { let s = 0; for (let i = 0; i < 2; i++) if (i === 1) s += p.m(); return s; }
function callBase(p: P): number { let s = 0; for (let i = 0; i < 2; i++) if (i === 1) s += p.base(); return s; }
function writeX(p: P, v: number): void { for (let i = 0; i < 1; i++) p.x = v; }
function readZ(s: Sub): number { let t = 0; for (let i = 0; i < 2; i++) if (i === 1) t += s.z; return t; }

function makeP(): P { return { y: 6, x: 5, m() { return 77; }, base() { return 78; } }; }
function idP<T extends P>(v: T): P { return v; }
class Box<T extends P> {
  constructor(public v: T) {}
  get(): P { return this.v; }
}
function isSub(p: P): p is Sub { return (p as Sub).z !== undefined; }

function main(): void {
  // parameters, returns, elements
  const lit = { y: 6, x: 5, m() { return 99; }, base() { return 98; } };
  console.log(readX(new P()), readX(lit), readY(lit), callM(lit), callBase(lit));
  const made = makeP();
  console.log(readX(made), readY(made), callM(made), made.m());
  const arr: P[] = [new P(), { m() { return 5; }, base() { return 4; }, y: 9, x: 8 }];
  let total = 0;
  for (const p of arr) total += readX(p) + readY(p) + callM(p);
  console.log(total);
  writeX(lit, 40);
  console.log(lit.x, lit.y, readX(lit));
  // any and casts
  const parsed = JSON.parse('{"y": 31, "x": 30}') as P;
  console.log(readX(parsed), readY(parsed));
  const partial = { x: 2 } as P;
  console.log(readX(partial), readY(partial));
  const viaAny: any = { y: 61, x: 60, m() { return 62; }, base() { return 63; } };
  const fromAny: P = viaAny;
  console.log(readX(fromAny), callM(fromAny));
  // an interface value, an unrelated class
  const iface: PLike = { base: () => 11, m: () => 12, y: 13, x: 14 };
  const fromIface: P = iface;
  console.log(readX(fromIface), readY(fromIface), callM(fromIface), callBase(fromIface));
  const other: P = new Other();
  console.log(readX(other), readY(other), callM(other), callBase(other));
  // generics constrained by the class
  console.log(readX(idP({ y: 71, x: 70, m() { return 72; }, base() { return 73; } })));
  const box = new Box({ y: 81, x: 80, m() { return 82; }, base() { return 83; } });
  console.log(readX(box.get()), callM(box.get()));
  // a literal typed as the subclass, read through the base class
  const sub: Sub = { z: 93, y: 92, x: 91, m() { return 94; }, base() { return 95; } };
  const up: P = sub;
  console.log(readX(up), readY(up), callM(up), readZ(sub));
  // a literal typed as the base class, downcast and guarded to the subclass
  const asBase: P = { z: 103, y: 102, x: 101, m() { return 104; }, base() { return 105; } } as P;
  console.log(readZ(asBase as Sub), isSub(asBase) ? readZ(asBase) : -1);
  // nested positions
  const holder: { p: P } = { p: { y: 112, x: 111, m() { return 113; }, base() { return 114; } } };
  const map = new Map<string, P>();
  map.set("k", { y: 122, x: 121, m() { return 123; }, base() { return 124; } });
  console.log(readX(holder.p), readX(map.get("k")!), callM(map.get("k")!));
  // real instances and a nominal class keep working
  const s = new Sub();
  console.log(readX(s), readZ(s), callM(s), callBase(s), new Nominal().read());
}
main();
export {};
