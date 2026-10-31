// @ts-nocheck
// `super` in an object literal's methods and accessors: the home object's prototype, the receiver `this`.
const base = { hi() { return "base hi " + this.n; }, get g() { return "getter " + this.n; }, v: 10, set s(x) { this.w = x * 2; } };
const o = { __proto__: base, n: 1, hi() { return "o>" + super.hi(); }, get g() { return "o:" + super.g; }, read() { return super.v; }, key(k) { return super[k]; }, arrow() { const f = () => super.hi(); return f(); }, put() { super.s = 4; return this.w; }, spread(...a) { return super.join ? 1 : a.length; } };
console.log(o.hi(), o.g, o.read(), o.key("v"), o.arrow(), o.put(), o.spread(1, 2));
const child = Object.create(o); child.n = 2;
console.log(child.hi());
const p = { m() { return typeof super.toString; } }; console.log(p.m());
function mk() { const a = { __proto__: { x: 1 }, f() { return super.x; } }; return a.f; }
console.log(mk().call({}));
Object.setPrototypeOf(p, { toString() { return "new"; } }); console.log(p.m());
