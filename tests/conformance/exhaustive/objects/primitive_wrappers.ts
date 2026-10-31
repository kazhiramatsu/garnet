// @ts-nocheck
// Number and Boolean objects: new Number, new Boolean, new Object(v), Object(v).
const n = new Number(5), b = new Boolean(false), o = new Object(), o1 = new Object(1), o2 = new Object(n), s = Object(true);
console.log(typeof n, n + 1, n * 2, n == 5, n === 5, typeof b, b ? "t" : "f", b == false, !b, n.toFixed(1), n.toString(), b.toString(), b.valueOf(), Object.keys(n).length, JSON.stringify([n, b]));
console.log(o, typeof o1, o1 + 1, o2 === n, typeof s, s.valueOf(), Object(1) === 1, new Number().valueOf(), new Number("7") * 1, new Boolean(0).valueOf(), new Boolean("x").valueOf());
console.log(n instanceof Number, b instanceof Boolean, Object.prototype.toString.call(n), Object.prototype.toString.call(b), String(n), `${b}`, n.constructor === Number, b.constructor === Boolean);
try { Number.prototype.valueOf.call("x"); } catch (e) { console.log(e.name); }
try { Boolean.prototype.toString.call(1); } catch (e) { console.log(e.name); }
console.log(n, b);
