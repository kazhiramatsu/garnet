// @ts-nocheck
// What each operation asks a Proxy, in order. Object.keys read every value, JSON.stringify read each value beside its
// descriptor where the keys come first, Object.getOwnPropertyDescriptors answered {} (silent) and Object.hasOwn asked nothing.
const log = [];
const h = {
  get(t, k, r) { log.push("get " + String(k)); return Reflect.get(t, k, r); },
  has(t, k) { log.push("has " + String(k)); return Reflect.has(t, k); },
  ownKeys(t) { log.push("ownKeys"); return Reflect.ownKeys(t); },
  getOwnPropertyDescriptor(t, k) { log.push("gopd " + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); },
};
const y = Symbol("y");
const make = () => {
  const t = { b: 1, 2: "two", a: [1], [y]: 2 };
  Object.defineProperty(t, "hidden", { value: 3, enumerable: false, configurable: true });
  return new Proxy(t, h);
};
const show = (name, f) => { log.length = 0; let r; try { r = f(); } catch (e) { r = e.name; } console.log(name, r, log.join(",")); };
show("keys", () => Object.keys(make()));
show("values", () => Object.values(make()));
show("entries", () => Object.entries(make()));
show("json", () => JSON.stringify(make()));
show("json indented", () => JSON.stringify(make(), null, 1));
show("json nested", () => JSON.stringify({ p: make() }));
show("json toJSON", () => JSON.stringify(new Proxy({ a: 1, toJSON() { return "t"; } }, h)));
show("descriptors", () => Object.getOwnPropertyDescriptors(make()));
show("descriptors symbol", () => Object.getOwnPropertyDescriptors(make())[y]);
show("hasOwn", () => [Object.hasOwn(make(), "b"), Object.hasOwn(make(), "zz")]);
show("hasOwn hidden", () => Object.hasOwn(make(), "hidden"));
show("hasOwn symbol", () => Object.hasOwn(make(), y));
show("hasOwnProperty", () => Object.prototype.hasOwnProperty.call(make(), "a"));
show("isEnumerable", () => Object.prototype.propertyIsEnumerable.call(make(), "hidden"));
show("spread", () => ({ ...make() }));
show("assign", () => Object.assign({}, make()));
show("rest", () => { const { a, ...r } = make(); return r; });
show("for in", () => { const k = []; for (const q in make()) k.push(q); return k; });
show("names", () => Object.getOwnPropertyNames(make()));
show("symbols", () => Object.getOwnPropertySymbols(make()).length);
show("ownKeys", () => Reflect.ownKeys(make()).length);
show("console", () => { console.log(make()); return "printed"; });

// a trap that answers what the target does not have, and an array behind a Proxy
const fake = new Proxy({}, { ownKeys() { return ["x", "y"]; }, getOwnPropertyDescriptor(t, k) { return { value: k, enumerable: k === "x", configurable: true }; }, get(t, k) { return k + "!"; } });
console.log(Object.keys(fake), Object.values(fake), JSON.stringify(fake), Object.getOwnPropertyDescriptors(fake), Object.hasOwn(fake, "x"), Object.hasOwn(fake, "z"));
show("json array", () => JSON.stringify(new Proxy([1, [2]], h)));
show("keys array", () => Object.keys(new Proxy([1, 2], h)));
show("descriptors array", () => Object.keys(Object.getOwnPropertyDescriptors(new Proxy([1], h))));
console.log(((f) => { try { return f(null); } catch (e) { return e.name; } })(Object.getOwnPropertyDescriptors), ((f) => { try { return f(undefined); } catch (e) { return e.name; } })(Object.getOwnPropertyDescriptors), Object.getOwnPropertyDescriptors(1), Object.getOwnPropertyDescriptors("a"));

// [[GetOwnProperty]]: the trap's answer is completed and held to the target
const g = (t, d) => new Proxy(t, { getOwnPropertyDescriptor() { return d; } });
const gd = (p, k) => { try { return Object.getOwnPropertyDescriptor(p, k); } catch (e) { return e.name; } };
const fixed = Object.defineProperty({}, "k", { value: 1, configurable: false, writable: false });
const loose = { k: 1 };
console.log(gd(g(loose, { value: 2, configurable: true }), "k"), gd(g(loose, { get() { return 1; }, configurable: true }), "k"), gd(g(loose, { configurable: true }), "k"));
console.log(gd(g(loose, undefined), "k"), gd(g({}, undefined), "k"), gd(g(fixed, undefined), "k"), gd(g(Object.preventExtensions({ k: 1 }), undefined), "k"));
console.log(gd(g({}, { value: 1, configurable: false }), "k"), gd(g(loose, { value: 1, configurable: false }), "k"), gd(g(fixed, { value: 2, configurable: false }), "k"), gd(g(fixed, { value: 1, configurable: false, writable: false }), "k"));
console.log(gd(g(Object.preventExtensions({}), { value: 1, configurable: true }), "k"), gd(g({}, 1), "k"), gd(g({}, "s"), "k"), gd(g({}, null), "k"), gd(g({}, Symbol("q")), "k"), gd(g({}, { get: 1, configurable: true }), "k"), gd(g({}, { get() {}, value: 1, configurable: true }), "k"));
console.log(gd(g(Object.defineProperty({}, "k", { value: 1, writable: true, configurable: false }), { value: 1, writable: false, configurable: false }), "k"));
const reads = [];
const d = new Proxy({ value: 1, configurable: true }, { get(t, k, r) { reads.push(String(k)); return Reflect.get(t, k, r); }, has(t, k) { reads.push("has " + String(k)); return Reflect.has(t, k); } });
console.log(gd(g({}, d), "k"), reads.join(","));
