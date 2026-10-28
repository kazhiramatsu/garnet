// fn.name / fn.length of class and object-literal members (Session 356): a method is named after
// its key, an accessor "get x" / "set x", a static method likewise, a well-known-symbol key
// "[Symbol.iterator]"; the length counts the parameters before the first default.
class Dep {
  track(a: number, b: number) { return a + b; }
  get dirty() { return 1; }
  set dirty(v: number) {}
  static s(x: number, y = 2) { return x + y; }
  [Symbol.iterator]() { return [1, 2][Symbol.iterator](); }
  "quoted key"() { return 3; }
}
function main() {
  const d = Object.getOwnPropertyDescriptor(Dep.prototype, "dirty")!;
  console.log(JSON.stringify([Dep.prototype.track.name, Dep.prototype.track.length, d.get!.name, d.get!.length,
    d.set!.name, d.set!.length, Dep.s.name, Dep.s.length, Dep.prototype[Symbol.iterator].name,
    Dep.prototype["quoted key"].name, new Dep().track.name, Dep.name]));
  const o = { m(x: number) { return x; }, f: (y: number) => y, get g() { return 2; }, h: function () { return 4; } };
  const og = Object.getOwnPropertyDescriptor(o, "g")!;
  console.log(JSON.stringify([o.m.name, o.m.length, o.f.name, og.get!.name, o.h.name, (function () {}).name, (() => 1).name]));
  const dep = new Dep();
  console.log(dep.track(1, 2), dep.dirty, Dep.s(1), [...dep].join(","), dep["quoted key"](), o.m(5), o.f(6), o.g, o.h());
}
main();
