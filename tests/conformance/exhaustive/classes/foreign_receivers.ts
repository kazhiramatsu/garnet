// Typed class-field accesses (struct offsets) on receivers without the
// sized-instance layout (docs/foreign_receivers_design.md): objects made by
// Object.create(C.prototype), plain objects relinked behind a class prototype
// (setPrototypeOf, Reflect.setPrototypeOf) with their keys in any order, and
// borrowed methods (call / apply / bind / Reflect.apply) reading and writing
// `this`; sized instances and a Proxy receiver alongside.
class Vec {
  x = 1; y = 2; label = "v";
  sum(): number { return this.x + this.y; }
  getX(): number { return this.x; }
  setX(v: number): void { this.x = v; }
  rename(s: string): string { this.label = s + "!"; return this.label; }
}
class Vec3 extends Vec { z = 3; total(): number { return this.sum() + this.z; } }

function viaCreate(): string {
  const p = Object.create(Vec.prototype) as Vec;
  p.x = 5; p.y = 6;
  const q = Object.create(Vec3.prototype) as Vec3;
  q.x = 1; q.y = 2; q.z = 30;
  const r = Object.assign(Object.create(Vec.prototype), { y: 4, x: 3 }) as Vec;
  return [p.sum(), p.getX(), q.total(), r.sum(), String(Object.keys(p)), p instanceof Vec].join(" ");
}
function viaRelink(): string {
  const a: any = { y: 9, x: 8, label: "a" };
  Object.setPrototypeOf(a, Vec.prototype);
  const b: any = { label: "b", x: 20, y: 22 };
  Reflect.setPrototypeOf(b, Vec3.prototype); b.z = 100;
  const va = a as Vec, vb = b as Vec3;
  va.setX(80);
  return [va.getX(), va.sum(), va.rename("A"), vb.total(), a.x, JSON.stringify(a)].join(" ");
}
function viaBorrow(): string {
  const plain = { y: 60, x: 50, label: "p" };
  const empty: any = {};
  Vec.prototype.setX.call(empty, 42);
  Vec.prototype.rename.apply(empty, ["e"]);
  const bound = Vec.prototype.sum.bind({ x: 7, y: 8 });
  const viaReflect = Reflect.apply(Vec.prototype.getX, { x: 13 }, []);
  return [Vec.prototype.getX.call(plain), Vec.prototype.sum.call(plain), empty.x, empty.label, Object.keys(empty).join(","), bound(), viaReflect].join(" ");
}
function sizedStillFast(): string {
  const vs: Vec[] = [];
  for (let i = 0; i < 5; i++) { const v = new Vec(); v.x = i; v.y = i * 2; vs.push(v); }
  const relinked = Object.setPrototypeOf({ y: 100, x: 1000 }, Vec.prototype) as Vec;
  vs.push(relinked);
  let s = 0; for (const v of vs) s += v.sum();
  const v3 = new Vec3(); v3.setX(4);
  return [s, v3.total(), v3.getX()].join(" ");
}
function proxied(): string {
  const target = new Vec(); target.x = 3;
  const p = new Proxy(target, { get(t, k, r) { return k === "y" ? 40 : Reflect.get(t, k, r); } });
  return [p.sum(), p.getX()].join(" ");
}
console.log(viaCreate());
console.log(viaRelink());
console.log(viaBorrow());
console.log(sizedStillFast());
console.log(proxied());
