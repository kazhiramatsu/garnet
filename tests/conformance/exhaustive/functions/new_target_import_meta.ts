// @ts-nocheck
// new.target in functions, constructors, subclasses, methods and arrows; import.meta's shape.
function F() { return new.target === F ? "new" : String(new.target); }
function G() { const a = () => new.target; this.nt = a() === G; }
class B { constructor() { this.t = new.target; const f = () => new.target; this.u = f(); } m() { return new.target; } x = (() => 1)(); }
class D extends B { constructor() { super(); this.d = new.target; } }
class E extends D {}
console.log(F(), typeof new F(), new G().nt, new B().t === B, new D().t === D, new D().u === D, new D().d === D, new E().t === E, new B().m());
const o = { F }; console.log(o.F(), F.call({}));
function H() { helper(); return new.target !== undefined; } function helper() { return new.target; }
function I() { helper2(); } function helper2() { return new.target; }
console.log(new (function () { this.v = helper(); })().v);
const m = import.meta; console.log(typeof m, Object.getPrototypeOf(m), m === import.meta, typeof m.url, m.url.startsWith("file://"), typeof m.dirname, typeof m.filename);
