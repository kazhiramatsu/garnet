// @ts-nocheck
// The classes stay stable here (no relink, no own method on an instance), so their `this.m()` calls are resolved
// statically and a borrow takes the clone: a class without fields (its instances are plain objects, the prototype is the
// test) and one with them (the class index is). `D.prototype.d.call({ y() {} })` ran C's y (silent).
class A { y() { return "A"; } }
class B extends A { y() { return "B"; } }
class C extends A { y() { return "C"; } }
class D extends C { d() { return this.y(); } twice() { return this.d() + "+" + this.d(); } }
class F { f = 1; g() { return this.h() + this.f; } h() { return 10; } }
class G2 { f = 2; h() { return 20; } }
class H extends F { k() { return this.g() * 2; } }
const t = (n, fn) => { try { console.log(n, fn()); } catch (e) { console.log(n, e.name); } };
t("own", () => [new D().d(), new D().twice(), new F().g(), new H().k()]);
t("sibling", () => D.prototype.d.call(new B()));
t("plain", () => D.prototype.d.call({ y() { return "plain"; } }));
t("plain without", () => D.prototype.d.call({}));
t("null", () => D.prototype.d.call(null));
t("undefined", () => D.prototype.d.call(undefined));
t("number", () => D.prototype.d.call(5));
t("nested", () => D.prototype.twice.call({ d() { return "x"; } }));
t("nested sibling", () => D.prototype.twice.call(new B()));
t("subclass", () => { class E extends D { y() { return "E"; } } return [new E().d(), D.prototype.d.call(new E())]; });
t("sized foreign", () => F.prototype.g.call(new G2()));
t("sized plain", () => F.prototype.g.call({ h() { return 100; }, f: 5 }));
t("sized subclass", () => [H.prototype.k.call({ g() { return 7; } }), F.prototype.g.call(new H())]);
t("apply", () => D.prototype.d.apply({ y: () => "apply" }));
t("bind", () => D.prototype.d.bind({ y: () => "bound" })());
t("method value", () => { const m = new D().d; return m.call({ y: () => "value" }); });
t("graft", () => { const o = { y: () => "graft", d: D.prototype.d }; return o.d(); });
t("loop", () => { let s = ""; for (let i = 0; i < 4; i++) s += D.prototype.d.call(i % 2 ? new B() : new D()); return s; });
t("reflect", () => Reflect.apply(D.prototype.d, { y: () => "reflect" }, []));
t("after", () => [new D().d(), new F().g(), new H().k()]);
