// @ts-nocheck
// A delete of a key an object does not have is true, frozen, sealed or not: it answered false through a static key (silent: a
// strict delete is true or throws) and threw through a dynamic one.
const t = (n, f) => { try { console.log(n, f()); } catch (e) { console.log(n, e.name); } };
const K: any[] = ["e", "7", "zz", "h"];
for (const [name, mk] of [["frozen create", () => Object.freeze(Object.create({ h: 1 }))], ["sealed create", () => Object.seal(Object.create({ h: 1 }))], ["frozen literal", () => Object.freeze({ a: 1 })], ["sealed literal", () => Object.seal({ a: 1 })], ["prevented", () => Object.preventExtensions({ a: 1 })], ["frozen array", () => Object.freeze([1, 2])], ["frozen empty", () => Object.freeze({})]]) {
  t(name + " static", () => delete mk().e);
  t(name + " literal key", () => delete mk()["e"]);
  t(name + " dynamic", () => delete mk()[K[0]]);
  t(name + " number", () => delete mk()[7]);
  t(name + " dynamic number", () => delete mk()[K[1]]);
  t(name + " inherited", () => delete mk()[K[3]]);
  t(name + " own", () => delete mk().a);
  t(name + " own dynamic", () => { const k = "a"; return delete mk()[k]; });
  t(name + " reflect", () => Reflect.deleteProperty(mk(), K[0]));
}
t("frozen instance", () => { class C { x = 1; } const c = Object.freeze(new C()); return [delete c.zz, Reflect.deleteProperty(c, "zz")]; });
t("frozen instance own", () => { class C { x = 1; } const c = Object.freeze(new C()); return delete c.x; });
t("frozen function", () => { const f = Object.freeze(function () {}); return [delete f.zz, Reflect.deleteProperty(f, "zz")]; });
