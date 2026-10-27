// An object literal's `__proto__: v` member sets the prototype (an object or null; any other value
// is ignored); the shorthand `{ __proto__ }` and the computed `{ ["__proto__"]: v }` make an own
// property, and JSON.parse makes one too. Every form must agree with V8.
function main(): void {
  const base = { inherited: 1, greet(): string { return "hi " + (this as any).own; } };
  const o: any = { __proto__: base, own: 2 };
  console.log(o.inherited, o.greet(), Object.getPrototypeOf(o) === base, JSON.stringify(o), Object.keys(o).join(","), Object.hasOwn(o, "__proto__"));
  const n: any = { __proto__: null, a: 1 };
  console.log(Object.getPrototypeOf(n), n.a, "toString" in n, JSON.stringify(n));
  const ignored: any = { __proto__: 5, b: 2 };
  console.log(Object.getPrototypeOf(ignored) === Object.prototype, JSON.stringify(ignored), ignored.b);
  const __proto__ = { viaShorthand: true };
  const sh: any = { __proto__, c: 3 };
  console.log(Object.getPrototypeOf(sh) === Object.prototype, sh.viaShorthand, Object.hasOwn(sh, "__proto__"), Object.keys(sh).join(","));
  const comp: any = { ["__proto__"]: { viaComputed: true }, d: 4 };
  console.log(Object.getPrototypeOf(comp) === Object.prototype, comp.viaComputed, Object.hasOwn(comp, "__proto__"), Object.keys(comp).join(","), JSON.stringify(comp));
  const parsed = JSON.parse('{"__proto__": {"x": 1}, "y": 2}');
  console.log(Object.getPrototypeOf(parsed) === Object.prototype, Object.hasOwn(parsed, "__proto__"), parsed.x, Object.keys(parsed).join(","));
  const chain: any = { __proto__: { __proto__: base, mid: "m" }, top: "t" };
  console.log(chain.inherited, chain.mid, chain.top, chain.greet(), Object.keys(chain).join(","));
  const late: any = { first: 1, __proto__: base, last: 2 };
  console.log(Object.keys(late).join(","), late.inherited, JSON.stringify(late));
}
main();
