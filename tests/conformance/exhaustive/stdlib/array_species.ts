// @ts-nocheck
const t = (name, f) => { try { console.log(name, f()); } catch (e) { console.log(name, "THROW", e.name, e.message); } };
class X extends Array { sum() { return this.reduce((a, b) => a + b, 0); } }
t("subclass", () => { const x = new X(); x.push(1, 2, 3); return [x.length, x instanceof X, x instanceof Array, Array.isArray(x), x.sum()]; });
t("ctor args", () => { const x = new X(3); return [x.length, new X(1, 2).length]; });
t("map", () => { const x = X.from([1, 2]); const m = x.map((v) => v * 2); return [x instanceof X, m instanceof X, m.constructor === X, (m as any).sum(), m.length]; });
t("filter", () => { const x = X.of(1, 2, 3); const m = x.filter((v) => v > 1); return [m instanceof X, m.length]; });
t("slice", () => { const x = X.of(1, 2, 3); const m = x.slice(1); return [m instanceof X, m.length]; });
t("splice", () => { const x = X.of(1, 2, 3); const m = x.splice(1, 1); return [m instanceof X, m.length, x.length]; });
t("concat", () => { const x = X.of(1); const m = x.concat([2]); return [m instanceof X, m.length]; });
t("flat", () => { const x = X.of([1], [2]); const m = x.flat(); return [m instanceof X, m.length]; });
t("flatMap", () => { const x = X.of(1); const m = x.flatMap((v) => [v, v]); return [m instanceof X, m.length]; });
t("species", () => { class Y extends Array { static get [Symbol.species]() { return Array; } } const y = new Y(); y.push(1); const m = y.map((v) => v); return [m instanceof Y, Array.isArray(m), Y[Symbol.species] === Array, X[Symbol.species] === X, Array[Symbol.species] === Array]; });
t("own constructor", () => { const a = [1, 2]; a.constructor = undefined; return a.map((v) => v).constructor === Array; });
t("ctor null", () => { const a = [1, 2]; a.constructor = null; return a.map((v) => v); });
t("ctor species null", () => { const a = [1, 2]; a.constructor = { [Symbol.species]: null }; return a.map((v) => v).constructor === Array; });
t("ctor custom", () => { const a = [1, 2]; let seen; function C(n) { seen = n; return {}; } a.constructor = { [Symbol.species]: C }; const r = a.map((v) => v * 2); return [seen, JSON.stringify(r)]; });
t("non ctor", () => { const a = [1]; a.constructor = { [Symbol.species]: 5 }; return a.map((v) => v); });
t("Array.of.call", () => { function C(n) { this.n = n; } const r = Array.of.call(C, 1, 2); return [r instanceof C, r.n, r[0], r.length]; });
t("Array.from.call", () => { function C(n) { this.n = n; } const r = Array.from.call(C, [1, 2]); return [r instanceof C, r.n, r[0], r.length]; });
t("getter", () => { const d = Object.getOwnPropertyDescriptor(Array, Symbol.species); return [typeof d.get, d.set, d.enumerable, d.configurable, d.get.name]; });
t("others", () => JSON.stringify([Map[Symbol.species] === Map, Set[Symbol.species] === Set, Promise[Symbol.species] === Promise, RegExp[Symbol.species] === RegExp, ArrayBuffer[Symbol.species] === ArrayBuffer, Object.getPrototypeOf(Int8Array)[Symbol.species] === Object.getPrototypeOf(Int8Array), Int8Array[Symbol.species] === Int8Array]));
class TA extends Uint8Array {}
t("ta subclass", () => { const a = new TA(2); return [a instanceof TA, a.map((v) => v) instanceof TA, a.slice() instanceof TA, a.subarray(0) instanceof TA, a.filter(() => true) instanceof TA]; });
t("ta species", () => { const a = new Uint8Array(2); a.constructor = { [Symbol.species]: Int16Array }; return [a.map((v) => v).constructor.name, a.slice().constructor.name, a.subarray(1).constructor.name]; });
t("buffer slice", () => { const b = new ArrayBuffer(4); b.constructor = { [Symbol.species]: function (n) { return new ArrayBuffer(n * 2); } }; return b.slice(0, 2).byteLength; });
t("concat spreadable", () => { const o = { length: 2, 0: "a", 1: "b", [Symbol.isConcatSpreadable]: true }; const a = [1]; a[Symbol.isConcatSpreadable] = false; return [[0].concat(o).length, [0].concat(a).length, JSON.stringify([0].concat(o))]; });
t("unscopables", () => { const u = Array.prototype[Symbol.unscopables]; return [Object.getPrototypeOf(u), u.at, u.flat, u.values, Object.keys(u).length]; });
