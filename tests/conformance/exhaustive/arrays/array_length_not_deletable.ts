// @ts-nocheck
// An array's `length` is an own property that is never configurable: `delete a.length` is a TypeError in a module (it
// answered true and nothing changed, silent), Reflect.deleteProperty answers false. A String object's is the same.
const t = (n, f) => { try { console.log(n, f()); } catch (e) { console.log(n, e.name); } };
const a = [1, 2, 3];
t("delete", () => delete a.length);
t("delete key", () => { const k = "length"; return delete a[k]; });
t("after", () => [a.length, a]);
t("reflect", () => Reflect.deleteProperty(a, "length"));
t("empty", () => delete [].length);
t("sparse", () => { const s = []; s[1000] = 1; return delete s.length; });
t("dictionary", () => { const d = [1, 2]; Object.defineProperty(d, 0, { get() { return 5; }, configurable: true }); return delete d.length; });
t("frozen", () => delete Object.freeze([1]).length);
t("element", () => { const e = [1, 2]; return [delete e[0], e]; });
t("string object", () => delete new String("ab").length);
t("string object reflect", () => Reflect.deleteProperty(new String("ab"), "length"));
t("function", () => { const f = function (x) {}; return [delete f.length, f.length]; });
t("typed array", () => { const u = new Uint8Array(2); return [delete u.length, u.length]; });
t("descriptor", () => Object.getOwnPropertyDescriptor([1], "length"));
