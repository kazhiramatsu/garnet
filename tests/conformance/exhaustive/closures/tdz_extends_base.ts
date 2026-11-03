// @ts-nocheck
// `class Sub extends Base` before a binding Base's methods read: defining Sub runs none of Base's code, so the binding is no
// dead-zone binding for that (tsc-ts's emptyTypes behind `class ObjectType extends Type`: 2.8% of its instructions in a
// test per read). A construction or a call that reaches Base's code before the declaration still throws.
const t = (n, f) => { try { console.log(n, f()); } catch (e) { console.log(n, e.name); } };
class Base { m() { return later; } static make() { return new this(); } }
class Sub extends Base { n() { return this.m().length; } }
t("call before", () => new Sub().m());
t("static before", () => Sub.make().n());
const later = [1, 2];
t("call after", () => [new Sub().n(), Sub.make().m()]);
class Base2 { get g() { return late2; } }
class Sub2 extends Base2 {}
class Sub3 extends Sub2 { h() { return this.g + "!"; } }
const late2 = "two";
t("getter after", () => [new Sub2().g, new Sub3().h()]);
function early3() { return new Sub4().k(); }
class Base4 { k() { return late4; } }
class Sub4 extends Base4 {}
t("function before", () => early3());
let late4 = 4;
t("function after", () => early3());
late4 = 5;
t("assigned", () => early3());
