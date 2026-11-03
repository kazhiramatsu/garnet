// @ts-nocheck
// A method run with a `this` of another class or of none (call, apply, bind, a method value, a graft): its `this.m()` was
// resolved from its own class's hierarchy and inlined, so `D.prototype.d.call({ y() {} })` ran C's y (silent). In a program that
// can borrow, the generic entry of such a method sends a foreign `this` to a clone whose calls on `this` dispatch by name.
class A { y() { return "A"; } who() { return this.y(); } }
class B extends A { y() { return "B"; } }
class C extends A { y() { return "C"; } }
class D extends C { d() { return this.y(); } twice() { return this.d() + this.d(); } }
class F { f = 1; g() { return this.h() + this.f; } h() { return 10; } }
class G2 { f = 2; h() { return 20; } }
const t = (n, fn) => { try { console.log(n, fn()); } catch (e) { console.log(n, e.name); } };
t("own", () => new D().d());
t("sibling", () => D.prototype.d.call(new B()));
t("plain", () => D.prototype.d.call({ y() { return "plain"; } }));
t("plain without", () => D.prototype.d.call({}));
t("null", () => D.prototype.d.call(null));
t("primitive", () => D.prototype.d.call(5));
t("string method", () => D.prototype.d.call(Object.assign(new String("s"), { y() { return "wrapped"; } })));
t("subclass", () => { class E extends D { y() { return "E"; } } return [new E().d(), D.prototype.d.call(new E())]; });
t("nested", () => D.prototype.twice.call({ d() { return "x"; } }));
t("sized", () => F.prototype.g.call(new G2()));
t("sized own", () => new F().g());
t("sized plain", () => F.prototype.g.call({ h() { return 100; }, f: 5 }));
t("apply", () => D.prototype.d.apply({ y: () => "apply" }));
t("bind", () => D.prototype.d.bind({ y: () => "bound" })());
t("method value", () => { const m = new D().d; return m.call({ y: () => "value" }); });
t("graft", () => { const o = { y: () => "graft", d: D.prototype.d }; return o.d(); });
t("loop", () => { let s = ""; for (let i = 0; i < 4; i++) s += D.prototype.d.call(i % 2 ? new B() : new D()); return s; });
t("relinked", () => { const d = new D(); Object.setPrototypeOf(d, { y: () => "relinked" }); return D.prototype.d.call(d); });
t("after", () => [new D().d(), new D().who(), new F().g()]);
