// @ts-nocheck
const log = (...a) => console.log(...a);
const t = (f) => { try { log("ok", f()); } catch (e) { log(e.name, e.message.slice(0, 60)); } };
class MyMap extends Map { get(k) { return "my:" + super.get(k); } get size2() { return this.size * 2; } }
const mm = new MyMap([["a", 1]]); mm.set("b", 2);
log(mm.get("a"), mm.size, mm.size2, mm instanceof Map, mm instanceof MyMap, [...mm.keys()].join(), Object.prototype.toString.call(mm));
class MySet extends Set { add(v) { return super.add(v * 2); } }
const ms = new MySet(); ms.add(1); ms.add(2); log([...ms].join(), ms.has(4), ms.size);
class MyArr extends Array { sum() { return this.reduce((a, b) => a + b, 0); } }
const ma = new MyArr(); ma.push(1, 2, 3); log(ma.sum(), ma.length, Array.isArray(ma), ma instanceof MyArr, ma instanceof Array, ma[1], JSON.stringify(ma));
const ma2 = new MyArr(3); log(ma2.length);
class MyP extends Promise { tag() { return 1; } }
const mp = new MyP((r) => r(5)); log(mp.tag(), mp instanceof Promise, mp instanceof MyP); mp.then((v) => log("then", v));
class O1 extends Object { a = 1; } log(JSON.stringify(new O1()), new O1() instanceof Object);
class Num extends Number { dbl() { return this * 2; } }
t(() => new Num(4).dbl());
class WM extends WeakMap { } t(() => { const k = {}; const w = new WM(); w.set(k, 1); return w.get(k); });
class Re extends RegExp { } t(() => new Re("a+").test("caat"));
class Err2 extends TypeError { constructor(m) { super(m); this.extra = 1; } } t(() => { const e = new Err2("x"); return [e.message, e.extra, e instanceof TypeError, e.name].join(); });
const Es = (B) => class extends B { label() { return "E:" + this.message; } };
class Err3 extends Es(RangeError) { } t(() => { const e = new Err3("y"); return [e.label(), e instanceof RangeError, e instanceof Error].join(); });
t(() => Map()); t(() => new Map([[1, 2]]).size); const V = Map; t(() => new V([[1, 2]]).get(1)); const Sx = [Set][0]; t(() => new Sx([1, 1, 2]).size);
t(() => Reflect.construct(Map, []).size);
