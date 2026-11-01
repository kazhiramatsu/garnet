// A bound function's length and name, a target without them, a receiver that is no function.
function f(a: number, b: number, c: number) { return a + b + c; }
const g = f.bind(null, 1);
console.log(g.length, g.name, "prototype" in g, Object.getOwnPropertyNames(g));
const h = g.bind(null, 2);
console.log(h.length, h.name, h(3));
const fn: any = function () {};
Object.defineProperty(fn, "name", { value: 7 });
console.log(JSON.stringify(fn.bind().name));
Object.defineProperty(fn, "name", { value: "n" });
console.log(fn.bind().name);
for (const v of [NaN, -0, Infinity, -Infinity, 3.66, -0.77, "3", undefined]) {
  Object.defineProperty(fn, "length", { value: v, configurable: true });
  console.log(fn.bind().length, fn.bind(0, 0).length);
}
delete fn.length;
console.log(fn.bind().length);
const P: any = Function.prototype.bind;
for (const x of [null, undefined, 1, "s", {}, []]) {
  try { P.call(x); console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); }
}
class A { x = 1; m() { return this.x; } static s() { return 2; } }
const a = new A();
console.log(a.m.bind(a).name, a.m.bind(a).length, A.bind(null).name, A.s.bind(A).name, (class {}).bind(null).name === "bound ");
console.log(Object.getOwnPropertyDescriptor(g, "name"), Object.getOwnPropertyDescriptor(g, "length"));
function later() {}
const b1 = later.bind(null);
Object.defineProperty(later, "name", { value: "renamed" });
console.log(b1.name, later.bind(null).name);
console.log(Math.round(0.49999999999999994), 1 / Math.round(-0.5), 1 / Math.round(-0.25), 1 / Math.round(-0), Math.round(2.5), Math.round(-2.5));
console.log(Math.round(1.5), Math.round(NaN), Math.round(Infinity), Math.round(-Infinity), Math.round(0.5), Math.round(1e300));
console.log(Math.round(4503599627370497), Math.round(-4503599627370495), Math.round(9007199254740991), Math.round(4503599627370495.5));
