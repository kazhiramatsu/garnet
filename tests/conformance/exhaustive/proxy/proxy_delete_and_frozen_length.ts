// @ts-nocheck
// A strict delete is true or a TypeError: a Proxy's deleteProperty trap that answers false gave false (silent). A frozen
// array's `length = NaN` is the TypeError of a read-only property, its value never converted (it was the RangeError).
const t = (n, f) => { try { console.log(n, f()); } catch (e) { console.log(n, e.name); } };
const refuse = new Proxy({ a: 1 }, { deleteProperty() { return false; } });
const fixed = new Proxy(Object.defineProperty({}, "k", { value: 1, configurable: false }), {});
t("trap false", () => delete refuse.a);
t("trap false key", () => { const k = "a"; return delete refuse[k]; });
t("trap false absent", () => delete refuse.zz);
t("reflect", () => Reflect.deleteProperty(refuse, "a"));
t("no trap, non-configurable", () => delete fixed.k);
t("no trap, absent", () => delete fixed.zz);
t("trap true", () => delete new Proxy({ a: 1 }, { deleteProperty(o, k) { return delete o[k]; } }).a);
let calls = 0;
const v = { valueOf() { calls++; return 1; } };
t("frozen NaN", () => { Object.freeze([1, 2]).length = NaN; });
t("frozen valueOf", () => { Object.freeze([1, 2]).length = v; return calls; });
t("read-only", () => { const a = [1, 2]; Object.defineProperty(a, "length", { writable: false }); a.length = -1; });
t("plain NaN", () => { const a = [1, 2]; a.length = NaN; });
t("plain valueOf", () => { const a = [1, 2, 3]; a.length = v; return [a, calls]; });
t("sealed shorter", () => { const a = Object.seal([1, 2]); a.length = 0; });
console.log(calls);
