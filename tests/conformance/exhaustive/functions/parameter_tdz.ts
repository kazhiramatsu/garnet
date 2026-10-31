// @ts-nocheck
const t = (f) => { try { console.log("ok", f()); } catch (e) { console.log(e.name, e.message); } };
function f1(x = y, y) { return x; }
t(() => f1());
t(() => f1(1));
function f2(x = x) { return x; }
t(() => f2());
function f3({ a = b, b }) { return a; }
t(() => f3({}));
t(() => f3({ a: 1 }));
function f4([a = a]) { return a; }
t(() => f4([]));
const f5 = (x = y, y = 1) => x;
t(() => f5());
function f6(x = () => y, y = 1) { return x(); }
t(() => f6());
function f7(x = 1, y = x + 1) { return y; }
t(() => f7());
function f8(x, y = x, { z = y } = {}) { return z; }
t(() => f8(4));
t(() => { let [a = a] = []; return a; });
t(() => { const { b = b } = {}; return b; });
t(() => { let { c = d, d } = {}; return c; });
t(() => { let e = e; return e; });
t(() => { const u = typeof v; let v; return u; });
t(() => { w = 1; let w; return w; });
function f9(a = typeof b, b) { return a; }
t(() => f9());
function f10(a = (b = 1), b) { return a; }
t(() => f10());
// an initializer's closure is not a read at the declaration
t(() => { const g = () => h; const h = 2; return g(); });
function f11(a = () => a) { return typeof a(); }
t(() => f11());
var args = (function (x = arguments[1], y) { return x; })(undefined, 5);
console.log(args);
