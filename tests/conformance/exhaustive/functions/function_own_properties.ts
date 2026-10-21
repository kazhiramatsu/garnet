// A function's own `name`, `length` and `prototype` (docs/function_own_properties_design.md):
// as the receiver and as a link of another object's prototype chain, for
// reads, `in`, writes, deletions, definitions, descriptors and key lists.
function show(label: string, f: () => unknown): void {
  try { console.log(label, String(f())); } catch (e) { console.log(label, "throws", (e as Error).constructor.name); }
}
function desc(o: object, k: string): string {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (!d) return "none";
  return `${typeof d.value === "function" ? "fn" : String(d.value)}/${d.writable}/${d.enumerable}/${d.configurable}`;
}
function named(a: number, b: number) { return a + b; }
const arrow = (x: number) => x;
class Plain { constructor(public v: number) {} m() { return "m"; } }
class WithStatics { static s = 5; static t() { return "t"; } constructor(a: number, b: number) {} }
class Derived extends WithStatics { constructor() { super(1, 2); } }
function main(): void {
  // reads through a chain
  const viaFn: any = Object.create(named);
  const viaArrow: any = Object.create(arrow);
  const viaPlain: any = Object.create(Plain);
  const viaStatics: any = Object.create(WithStatics);
  const viaDerived: any = Object.create(Derived);
  const deeper: any = Object.create(viaFn);
  show("fn", () => [viaFn.name, viaFn.length, viaFn.prototype === named.prototype].join(","));
  show("arrow", () => [viaArrow.name, viaArrow.length, viaArrow.prototype].join(","));
  show("class", () => [viaPlain.name, viaPlain.length, viaPlain.prototype === Plain.prototype].join(","));
  show("statics", () => [viaStatics.name, viaStatics.length, viaStatics.s, viaStatics.t()].join(","));
  show("derived", () => [viaDerived.name, viaDerived.length, viaDerived.s].join(","));
  show("deeper", () => [deeper.name, deeper.length].join(","));
  show("methods", () => [typeof viaFn.call, typeof viaFn.bind, typeof viaFn.apply].join(","));
  // presence
  show("in", () => ["name" in viaFn, "length" in viaFn, "prototype" in viaFn, "prototype" in viaArrow].join(","));
  show("own", () => [Object.prototype.hasOwnProperty.call(viaFn, "name"), Object.prototype.hasOwnProperty.call(named, "name"),
    Object.prototype.hasOwnProperty.call(named, "prototype"), Object.prototype.hasOwnProperty.call(arrow, "prototype")].join(","));
  show("reflect", () => [Reflect.has(viaFn, "length"), Reflect.get(viaFn, "name")].join(","));
  // writes through a chain: read-only name and length, a class's prototype
  show("set inherited name", () => { viaFn.name = "x"; return viaFn.name; });
  show("set inherited length", () => { viaFn.length = 3; return viaFn.length; });
  show("set inherited prototype", () => { viaFn.prototype = 7; return viaFn.prototype + "/" + Object.keys(viaFn).join(","); });
  show("set class prototype", () => { viaPlain.prototype = 7; return viaPlain.prototype; });
  // writes to the function itself
  function own1(a: number) { return a; }
  const o1: any = own1;
  show("set name", () => { o1.name = "y"; return o1.name; });
  show("set length", () => { o1.length = 9; return o1.length; });
  show("set prototype", () => { const p = { tag: 1 }; o1.prototype = p; return o1.prototype === p; });
  show("set class own prototype", () => { (Plain as any).prototype = {}; return "assigned"; });
  show("set other", () => { o1.extra = 1; return o1.extra + "/" + Object.keys(o1).join(","); });
  // deletions
  function own2(a: number, b: number) { return a + b; }
  const o2: any = own2;
  o2.user = 1;
  show("delete user", () => [delete o2.user, o2.user, "user" in o2].join(","));
  show("delete name", () => [delete o2.name, o2.name === "", "name" in o2, Object.prototype.hasOwnProperty.call(o2, "name")].join(","));
  show("delete length", () => [delete o2.length, o2.length, Object.prototype.hasOwnProperty.call(o2, "length")].join(","));
  show("delete prototype", () => delete o2.prototype);
  show("set deleted name", () => { o2.name = "z"; return o2.name; });
  const ws: any = WithStatics;
  show("delete static", () => [delete ws.s, ws.s, typeof ws.t].join(","));
  // definitions
  function own3() { return 0; }
  const o3: any = own3;
  show("define name", () => { Object.defineProperty(o3, "name", { value: "renamed" }); return o3.name + "/" + desc(o3, "name"); });
  show("define writable length", () => { Object.defineProperty(o3, "length", { writable: true }); o3.length = 4; return o3.length + "/" + desc(o3, "length"); });
  show("inherit defined", () => { const v: any = Object.create(o3); return v.name + "/" + v.length; });
  show("delete defined", () => [delete o3.name, o3.name === "", "name" in o3].join(","));
  // descriptors and key lists
  function own4(a: number, b: number, c: number) { return a + b + c; }
  const o4: any = own4;
  o4.later = 1;
  show("descs", () => [desc(own4, "name"), desc(own4, "length"), desc(own4, "prototype"), desc(arrow, "prototype")].join(" "));
  show("names", () => Object.getOwnPropertyNames(own4).join(","));
  show("arrow names", () => Object.getOwnPropertyNames(arrow).join(","));
  show("class names", () => Object.getOwnPropertyNames(WithStatics).join(","));
  show("descriptors", () => Object.keys(Object.getOwnPropertyDescriptors(own4)).join(","));
  show("for-in", () => { const ks: string[] = []; for (const k in o4) ks.push(k); return ks.join(","); });
  // sealed and frozen functions
  function own5(a: number) { return a; }
  const o5: any = own5;
  Object.seal(o5);
  show("sealed", () => [desc(o5, "name"), delete o5.name, o5.name].join(" "));
  function own6(a: number) { return a; }
  const o6: any = own6;
  Object.freeze(o6);
  show("frozen", () => [desc(o6, "length"), Object.isFrozen(o6)].join(" "));
  show("frozen prototype", () => { o6.prototype = {}; return "assigned"; });
}
main();
