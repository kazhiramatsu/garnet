// @ts-nocheck
class A { m() { return "A.m"; } get g() { return this.v; } set g(x) { this.v = x * 2; } static s() { return "A.s"; } }
class B extends A {
  m() { const k = "m"; return "B:" + super[k](); }
  r(k) { return super[k]; }
  w(k, v) { super[k] = v; return this.v; }
  arrow() { return (() => super["m"]())(); }
  static s() { return "B:" + super["s"](); }
}
const b = new B();
console.log(b.m(), typeof b.r("m"), b.w("g", 4), b.arrow(), B.s());
console.log(b.w("own", 5), b.own);
const o = { __proto__: { x: 1 }, m() { const k = "x"; return super[k]; } }; console.log(o.m());
// new of values
var x = {};
try { new x(x = Array); } catch (e) { console.log(e.name, x === Array); }
var X = function (a) { this.a = a; }; const y = new X(1); console.log(y.a);
function mk() { return function (a) { this.size = a.length; }; } console.log(new (mk())([1, 2]).size);
const nf = (...a) => { class L { constructor(p, q) { this.s = p + q; } } const KK = L; return new KK(...a).s; }; console.log(nf(1, 2));
try { new (1)(); } catch (e) { console.log(e.name); }
try { new (() => {})(); } catch (e) { console.log(e.name); }
// instanceof of values
var OBJECT = 0;
console.log((OBJECT = Object, {}) instanceof OBJECT);
var object = {}; console.log(object instanceof (object = 0, Object));
try { ({} instanceof 1); } catch (e) { console.log(e.name); }
try { ({} instanceof {}); } catch (e) { console.log(e.name); }
console.log(({}) instanceof Object, [] instanceof Object, (() => {}) instanceof Function);
// defineProperty forms
var obj = {};
Object.defineProperty(obj, "p", { get: function () { return 11; }, set: undefined, enumerable: true, configurable: true });
try { obj.p /= 20; } catch (e) { console.log(e.name); }
const g2 = function () { return 2; };
Object.defineProperty(obj, "q", { get: g2 }); console.log(obj.q);
try { Object.defineProperty(obj, "z", { get: g2, value: 1 }); } catch (e) { console.log(e.name); }
try { Object.defineProperty(obj, "z", { get: 1 }); } catch (e) { console.log(e.name); }
// computed accessor keys capturing module vars
var _; var stringSet;
var acc = { get [[_ = "str" + "ing"]]() { return "get string"; }, set [[_ = "str" + "ing"]](param) { stringSet = param; } };
console.log(acc["string"]); acc["string"] = "set string"; console.log(stringSet);
