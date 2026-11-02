// @ts-nocheck
const o: any = { a: 1, b: [1, 2, { c: 3 }], d: new Date(5), m: new Map([[1, { x: 2 }]]), s: new Set([1, "a"]), r: /a+/gi, u: undefined, n: null, big: 10n };
o.self = o;
const c = structuredClone(o);
console.log(c.a, c.b, c.d instanceof Date, c.d.getTime(), c.m.get(1), c.s.has("a"), c.r.source, c.r.flags, "u" in c, c.n, c.big, c.self === c, c !== o, c.b !== o.b);
console.log(structuredClone(1), structuredClone("s"), structuredClone(null), structuredClone(undefined), structuredClone(true));
const ta = new Uint8Array([1, 2, 3]); const tc = structuredClone(ta); tc[0] = 9; console.log(ta[0], tc[0], tc instanceof Uint8Array, tc.buffer !== ta.buffer);
const buf = new ArrayBuffer(4); new Int32Array(buf)[0] = 7; const bc = structuredClone(buf); console.log(new Int32Array(bc)[0], bc !== buf, bc.byteLength);
class K { x = 1; m() {} get g() { return 2; } }
const kc = structuredClone(new K()); console.log(kc, kc instanceof K, Object.getPrototypeOf(kc) === Object.prototype);
for (const bad of [Symbol("s"), new WeakMap(), Promise.resolve(1)]) { try { console.log(structuredClone(bad)); } catch (e: any) { console.log(e.name, e.code, e.message); } }
for (const bad of [() => {}, { f() {} }]) { try { structuredClone(bad); } catch (e: any) { console.log(e.name, e.code); } }
const e = structuredClone(new TypeError("boom")); console.log(e instanceof TypeError, e.name, e.message, typeof e.stack);
const g: any = { get v() { return 5; } }; console.log(Object.getOwnPropertyDescriptor(structuredClone(g), "v"));
const nm: any = {}; Object.defineProperty(nm, "hidden", { value: 1, enumerable: false }); nm.vis = 2; console.log(structuredClone(nm));
const sp = [1, , 3]; console.log(structuredClone(sp), 1 in structuredClone(sp));
const bo = new Boolean(false), nu = new Number(1), st = new String("x"); console.log(structuredClone(bo), structuredClone(nu), structuredClone(st));
console.log(structuredClone({ a: 1 }, { transfer: [] }));
try { (structuredClone as any)(); } catch (e: any) { console.log(e.name, e.message); }
const ab = new ArrayBuffer(8); const t2 = structuredClone(ab, { transfer: [ab] }); console.log(t2.byteLength, ab.byteLength);
