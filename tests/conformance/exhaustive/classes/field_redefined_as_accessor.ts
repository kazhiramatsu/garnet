// @ts-nocheck
// A class field redefined as an accessor or as read-only: the instance becomes a dictionary object, as a delete of a field makes
// it, and its typed accesses take the generic path. Both were TypeErrors (a class field stayed a data property and writable).
class A { a: any = 1; b: any = 2; }
const t = (n, f) => { try { console.log(n, f()); } catch (e) { console.log(n, e.name, e.message); } };
const log = [];
t("accessor over a field", () => { const o: any = new A(); Object.defineProperty(o, "a", { get() { log.push("g"); return 5; }, set(v) { log.push("s"); }, configurable: true }); return [o.a, (o as A).a, Object.keys(o), JSON.stringify(o), log.splice(0)]; });
t("getter only", () => { const o: any = new A(); Object.defineProperty(o, "b", { get() { return 6; } }); return [o.b, Object.keys(o), Object.getOwnPropertyDescriptor(o, "b").set]; });
t("data over a field", () => { const o: any = new A(); Object.defineProperty(o, "a", { value: 9, enumerable: false }); return [o.a, Object.keys(o)]; });
t("typed read after", () => { const o = new A(); Object.defineProperty(o, "a", { get() { return 7; } }); return o.a; });
t("read-only field", () => { const o: any = new A(); Object.defineProperty(o, "a", { writable: false }); try { o.a = 3; } catch (e) { log.push(e.name); } return [o.a, Object.getOwnPropertyDescriptor(o, "a"), log.splice(0)]; });
t("typed write after", () => { const o = new A(); Object.defineProperty(o, "a", { set(v) { log.push("set " + v); }, get() { return 1; } }); o.a = 4; return [o.a, log.splice(0)]; });
t("frozen", () => { const o: any = Object.freeze(new A()); Object.defineProperty(o, "a", { get() { return 1; } }); return o.a; });
t("sealed", () => { const o: any = Object.seal(new A()); Object.defineProperty(o, "a", { get() { return 1; } }); return o.a; });
t("subclass", () => { class B extends A { c = 3; } const o: any = new B(); Object.defineProperty(o, "c", { get() { return 8; }, enumerable: true }); return [o.c, o.a, Object.keys(o), (o as B).c]; });
t("method still", () => { class M { a = 1; m() { return this.a + 1; } } const o: any = new M(); Object.defineProperty(o, "a", { get() { return 10; } }); return o.m(); });
t("other instances", () => { const x = new A(), y: any = new A(); Object.defineProperty(y, "a", { get() { return 11; } }); return [x.a, y.a, (y as A).a]; });
