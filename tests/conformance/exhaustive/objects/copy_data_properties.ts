// @ts-nocheck
// CopyDataProperties: an object spread defines, it does not set; from a Proxy the traps run in the specification's
// order, symbols where ownKeys put them. ToPrimitive: an own property that is no function shadows the method.
const log = [];
const o = { set a(v) { log.push("setter"); }, ...{ a: 1 } };
console.log(log, Object.getOwnPropertyDescriptor(o, "a").value);
class S { set x(v) { log.push("protoset"); } }
const p = { __proto__: new S(), ...{ x: 1 } };
console.log(log, Object.keys(p));
const g = {}; Object.defineProperty(g, "k", { get() { log.push("get"); return 1; }, enumerable: true });
const c = { ...g }; console.log(Object.getOwnPropertyDescriptor(c, "k").writable, log);
console.log(Object.assign({ set a(v) { console.log("assign sets", v); } }, { a: 1 }).a);

const sym = Symbol("s"), trace = [];
const keysOf = (l) => l.map((k) => (typeof k === "symbol" ? "sym" : k)).join();
const proxy = new Proxy({}, {
  ownKeys() { trace.push("ownKeys"); return [sym, "foo", "0", "hidden"]; },
  getOwnPropertyDescriptor(_, k) { trace.push("gopd " + String(k)); return { value: 1, enumerable: k !== "hidden", configurable: true }; },
  get(_, k) { trace.push("get " + String(k)); return "v"; },
});
const sp = { ...proxy };
console.log(trace.join(), Object.keys(sp).join(), sp[sym]);
trace.length = 0;
const { foo, ...rest } = proxy;
console.log(foo, trace.join(), Object.keys(rest).join());
trace.length = 0;
console.log(Object.keys(Object.assign({}, proxy)).join(), trace.join());

const shadow = { toString: undefined, valueOf() { return "f"; } };
console.log(String(shadow), `${shadow}`, shadow + "", Object.keys({ [shadow]: 1 }));
const shadow2 = { valueOf: null, toString() { return "t"; } };
console.log(shadow2 + "", Number({ valueOf: 1, toString() { return "7"; } }));
try { String({ toString: undefined, valueOf: undefined }); } catch (e) { console.log(e.name); }
