const sk = Symbol("k");
const w = { [Symbol.toPrimitive]() { return sk; } };
const o2: any = { [sk]: 1 };
console.log(Object.hasOwn(o2, w as any), o2.hasOwnProperty(w), o2.propertyIsEnumerable(w), (w as any) in o2, o2[w as any]);
const P1: any = new Proxy({}, { getPrototypeOf() { return Symbol() as any; } });
try { console.log(Object.getPrototypeOf(P1)); } catch (e: any) { console.log(e.name, e.message); }
const T0 = new Proxy({}, { preventExtensions() { return false; } });
const P2 = new Proxy(T0, {});
try { Object.preventExtensions(P2); console.log("no throw"); } catch (e: any) { console.log(e.name, e.message); }
console.log(Reflect.preventExtensions(P2));
let seen: any;
const T1 = new Proxy(function () {}, { construct(_t, args, nt) { seen = nt; return { sum: args[0] + args[1] }; } });
const P3 = new Proxy(T1, {});
const NT = function () {};
const obj: any = Reflect.construct(P3, [3, 4], NT);
console.log(seen === NT, obj.sum);
const obj2: any = new P3(1, 2);
console.log(seen === P3, obj2.sum);
for (const v of [undefined, null, 1, true, "", Symbol()]) { try { (Reflect.apply as any)(function () { return 1; }, null, v); console.log("no throw"); } catch (e: any) { console.log(e.name, e.message); } }
try { (Reflect.apply as any)(function () { return 1; }, null); console.log("no throw"); } catch (e: any) { console.log(e.name, e.message); }
console.log(Reflect.apply(Math.max, null, [1, 3, 2]), Reflect.apply(function (this: any, a: number) { return this.x + a; }, { x: 1 }, { 0: 2, length: 1 } as any));
// Reflect.set refusals on other kinds
const f = Object.freeze([1, 2]);
console.log(Reflect.set(f, 0, 9), f[0], Reflect.set(f, 5, 9), f.length);
const ne = Object.preventExtensions([1]);
console.log(Reflect.set(ne, 0, 7), Reflect.set(ne, 3, 7), ne);
function fn() {}
console.log(Reflect.set(fn, "length", 3), fn.length, Reflect.set(fn, "x", 1), (fn as any).x);
console.log(Reflect.set(new Int8Array(2), 0, 1), Reflect.set(new Int8Array(2), 5, 1), Reflect.set(new Int8Array(2), "1.5", 1));
const t = new Float64Array(1);
Reflect.set(t, "1.0", "s"); console.log((t as any)["1.0"]);
Object.defineProperty(t, "1.0", { writable: false, value: undefined });
console.log(Reflect.set(t, "1.0", 42), (t as any)["1.0"]);
const ac = [1]; Object.defineProperty(ac, "x", { get() { return 1; } });
console.log(Reflect.set(ac, "x", 2), Reflect.set(ac, "y", 2), (ac as any).y);
class S2 { static set v(x: number) { console.log("set", x); } }
console.log(Reflect.set(S2, "v", 3));
const d = new Date(0); console.log(Reflect.set(d, "z", 1), (d as any).z);
const m = new Map(); console.log(Reflect.set(m, "z", 1), (m as any).z);
// with() across a shrink
const b = new (ArrayBuffer as any)(3, { maxByteLength: 3 });
const s = new Uint8Array(b); s[0] = 1; s[1] = 2; s[2] = 3;
const r = (s as any).with({ valueOf() { (b as any).resize(1); return 0; } } as any, 9);
console.log(r, s.length);
