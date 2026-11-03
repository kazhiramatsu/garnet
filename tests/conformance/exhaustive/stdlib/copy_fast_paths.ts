// @oracle esnext
// the fast paths and what must leave them
console.log("aBc1".toUpperCase(), "aBc1".toLowerCase(), "ABC".toUpperCase(), "abc".toLowerCase(), "".toUpperCase(), "ß".toUpperCase(), "İ".toLowerCase(), "Σ".toLowerCase(), "ÄÖ".toLowerCase(), "x{|}`@[".toUpperCase(), "A@[`".toLowerCase());
const h = [1, , 3];
console.log(h.slice(0), 1 in h.slice(0), h.concat([4, , 6]), 1 in h.concat([]), [...h], 1 in [...h], h.slice(1, 2).length);
(Array.prototype as any)[1] = "P";
console.log([...h], h.slice(0)[1], 1 in h.slice(0));
delete (Array.prototype as any)[1];
const a = [1, 2, 3]; a.push(...a); console.log(a);
const big: number[] = []; for (let i = 0; i < 1000; i++) big.push(i);
console.log(big.concat(big).length, big.slice(10, 20).join(), [...big].length, big.indexOf(500), big.lastIndexOf(500), big.includes(999), big.includes(1000));
console.log([0, -0].indexOf(-0), [-0].indexOf(0), [-0].includes(0), [NaN].indexOf(NaN), [NaN].includes(NaN), [, 1].includes(undefined), [, 1].indexOf(undefined), ["a", "b"].indexOf("b"), [true, null, undefined].indexOf(null), [true, null, undefined].indexOf(undefined), [1n, 2n].indexOf(2n), [1n, 2n].includes(2n), ["ab" + "c"].includes("a" + "bc"));
const o1 = { a: 1 }; console.log([o1, {}].indexOf(o1), [o1].includes({ a: 1 } as any), [o1].includes(o1));
const f = Object.freeze([1]); try { (f as any).push(...[2]); } catch (e: any) { console.log(e.name); }
for (const T of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) { const t = new T(5); t.fill(300.7, 1, 4); console.log(T.name, t.join()); t.fill(-1); console.log(t[0], t[4]); t.fill(2, -2); console.log(t.join()); t.fill(9, 3, 1); }
const b64 = new BigInt64Array(3); b64.fill(5n, 1); console.log(b64.join());
// spread
const s0 = { a: 1, b: "x", c: { d: 1 } };
const s1 = { ...s0 }; s1.a = 2; console.log(s0, s1, Object.keys(s1));
const s2 = { ...s0, e: 5, a: 9 }; console.log(s2, Object.keys(s2));
const s3 = { z: 0, ...s0 }; console.log(s3, Object.keys(s3));
const n0: any = { b: 1, 2: "two", a: 3, 1: "one" }; console.log(Object.keys({ ...n0 }), Object.keys(Object.assign({}, n0)));
const ac = { get g() { return 7; }, p: 1 }; console.log(Object.getOwnPropertyDescriptor({ ...ac }, "g"), Object.getOwnPropertyDescriptor(Object.assign({}, ac), "g"));
const ne: any = { v: 1 }; Object.defineProperty(ne, "h", { value: 2, enumerable: false }); console.log({ ...ne }, Object.assign({}, ne));
const sy = Symbol("s"); const ss = { [sy]: 1, q: 2 }; console.log({ ...ss }, Object.assign({}, ss), Object.getOwnPropertySymbols({ ...ss }).length);
const pr = JSON.parse('{"__proto__": 5, "x": 1}'); console.log(Object.keys({ ...pr }), Object.getPrototypeOf({ ...pr }) === Object.prototype, Object.keys(Object.assign({}, pr)), Object.getPrototypeOf(Object.assign({}, pr)) === Object.prototype);
const many: any = {}; for (let i = 0; i < 40; i++) many["k" + i] = i; const mc = { ...many }; console.log(Object.keys(mc).length, mc.k39, Object.keys(Object.assign({}, many)).length);
class C2 { x = 1; y = 2; get z() { return 3; } m() {} } console.log({ ...new C2() }, Object.assign({}, new C2()));
console.log({ ...(null as any) }, { ...(undefined as any) }, { ...(1 as any) }, { ...("ab" as any) }, { ...[5, 6] }, Object.assign({}, "cd"), Object.assign({}, null));
Object.defineProperty(Object.prototype, "w", { set(v) { console.log("setter", v); }, configurable: true });
console.log(Object.keys(Object.assign({}, { w: 1, u: 2 })), Object.keys({ ...{ w: 1 } }));
delete (Object.prototype as any).w;
const fz = Object.freeze({ a: 1 }); const fc: any = { ...fz }; fc.a = 2; console.log(fc, Object.isFrozen(fc));
const cn = { ...{ a: 1 } }; (cn as any).b = 2; delete (cn as any).a; console.log(cn);
