// Typed arrays under reflection (docs/typed_arrays_design.md): the
// integer-indexed own properties, defineProperty, the integrity levels, and
// generic Array.prototype methods and destructuring over views and array-likes.
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}
const a = new Int32Array([1, 2, 3]);
const d: any = a;

// own properties
report("named", () => { d.foo = 5; return d.foo; });
report("keys", () => Object.keys(a).join());
report("values entries", () => [Object.values(a).join(), JSON.stringify(Object.entries(a))].join(" "));
report("names", () => Object.getOwnPropertyNames(new Uint8Array(2)).join());
report("for in", () => { const ks: string[] = []; for (const k in a) ks.push(k); return ks.join(); });
report("in", () => [0 in d, 3 in d, "length" in d, "foo" in d, "-0" in d, "1.5" in d].join());
report("hasOwn", () => [a.hasOwnProperty(0), a.hasOwnProperty("length"), a.hasOwnProperty(5)].join());
report("descriptor", () => JSON.stringify(Object.getOwnPropertyDescriptor(a, 0)));
report("assign", () => JSON.stringify(Object.assign({}, new Uint8Array([7, 8]))));
report("spread object", () => JSON.stringify({ ...new Uint8Array([7, 8]) }));
report("oob write", () => { d[10] = 5; return [d[10], a.length].join(); });
report("negative key", () => { d[-1] = 5; return d[-1]; });
report("fraction key", () => { d["1.5"] = 5; return d["1.5"]; });
report("minus zero key", () => { d["-0"] = 5; return d["-0"]; });

// strict-mode writes and deletes
report("length write", () => { d.length = 9; return a.length; });
report("byteOffset write", () => { d.byteOffset = 1; return a.byteOffset; });
report("byteLength write", () => { (new ArrayBuffer(2) as any).byteLength = 3; });
report("delete element", () => delete d[0]);
report("delete past end", () => delete d[5]);
report("delete named", () => { d.bar = 1; return [delete d.bar, d.bar].join(); });

// defineProperty on elements
for (const [label, desc] of [
  ["value", { value: 9 }],
  ["all attributes", { value: 8, writable: true, enumerable: true, configurable: true }],
  ["read-only", { value: 7, writable: false }],
  ["accessor", { get() { return 1; } }],
  ["non-configurable", { value: 6, configurable: false }],
  ["empty", {}],
] as [string, PropertyDescriptor][]) {
  report("define " + label, () => { const b = new Uint8Array(2); Object.defineProperty(b, 0, desc); return b[0]; });
}
report("define past end", () => Object.defineProperty(new Uint8Array(2), 5, { value: 1 }));
report("define fraction", () => Object.defineProperty(new Uint8Array(2), "1.5", { value: 1 }));
report("reflect define", () => [Reflect.defineProperty(new Uint8Array(2), 5, { value: 1 }), Reflect.defineProperty(new Uint8Array(2), 1, { value: 1 })].join());
report("define named", () => { const b: any = new Uint8Array(1); Object.defineProperty(b, "tag", { value: "t", enumerable: true }); return [b.tag, Object.keys(b).join()].join(" "); });

// integrity levels
report("freeze", () => { const b = new Uint8Array(2); try { Object.freeze(b); } catch (e) { console.log((e as Error).message); } return [Object.isFrozen(b), Object.isExtensible(b)].join(); });
report("freeze empty", () => { const b = new Uint8Array(0); Object.freeze(b); return Object.isFrozen(b); });
report("seal", () => Object.seal(new Uint8Array(2)));
report("seal non-extensible", () => { const b = new Uint8Array(2); Object.preventExtensions(b); Object.seal(b); b[0] = 3; return [Object.isSealed(b), Object.isFrozen(b), b[0]].join(); });
report("prevent extensions", () => { const b: any = new Uint8Array(1); Object.preventExtensions(b); b[0] = 3; try { b.x = 1; } catch (e) { console.log((e as Error).constructor.name); } return [Object.isExtensible(b), b[0], b.x].join(); });

// generic Array.prototype methods and destructuring
const v = new Int32Array([4, 5, 6]);
const like: any = { length: 3, 0: "a", 2: "c" };
report("destructure", () => { const [x, y, ...r] = v; return [x, y, r.length, Array.isArray(r)].join(); });
report("destructure skip", () => { const [, , z] = v; return z; });
report("slice.call", () => [Array.prototype.slice.call(v, 1).join(), Array.isArray(Array.prototype.slice.call(v))].join(" "));
report("map.call", () => Array.prototype.map.call(v, (x: number) => x * 2).join());
report("join.call", () => [Array.prototype.join.call(v, "+"), Array.prototype.join.call(like, "+")].join(" "));
report("indexOf.call", () => [Array.prototype.indexOf.call(v, 5), Array.prototype.includes.call(like, "c")].join());
report("reduce.call", () => Array.prototype.reduce.call(v, (p: number, x: number) => p + x, 0));
report("filter.call like", () => JSON.stringify(Array.prototype.filter.call(like, () => true)));
report("slice.call like", () => JSON.stringify(Array.prototype.slice.call(like)));
report("slice.call string", () => Array.prototype.slice.call("abc", 1).join());
report("reverse.call", () => { const t = new Uint8Array([1, 2, 3]); Array.prototype.reverse.call(t); return t.join(); });
report("fill.call", () => { const t = new Uint8Array(3); Array.prototype.fill.call(t, 7, 1); return t.join(); });
report("toString.call", () => [Array.prototype.toString.call(v), Array.prototype.toString.call({})].join(" "));
report("slice.call null", () => Array.prototype.slice.call(null as any));
report("concat", () => ([] as unknown[]).concat(v as unknown as unknown[]).length);
report("push spread", () => { const r: number[] = [1]; r.push(...v); return r.join(); });
report("Array.from like", () => Array.from(like).join());
