// @ts-nocheck
const t = (name, f) => { try { console.log(name, JSON.stringify(f())); } catch (e) { console.log(name, "THROW", e.name, e.message); } };
class A { x = 1; constructor() { this.y = 2; } }
class B extends A {}
const a: any = A;
t("direct", () => A());
t("value", () => a());
t("sub", () => B());
t("call", () => A.call({}));
t("apply", () => a.apply({}));
t("reflect", () => Reflect.apply(A, {}, []));
t("map", () => [1].map(A));
t("bound", () => A.bind({})());
t("dyn", () => { const c = class {}; return c(); });
t("expr", () => (class {})());
t("fn wrap", () => { function F() { return A(); } return F(); });
