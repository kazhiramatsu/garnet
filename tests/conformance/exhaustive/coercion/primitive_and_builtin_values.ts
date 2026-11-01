// @ts-nocheck
const log = (...a) => console.log(...a);
const t = (f) => { try { log("ok", f()); } catch (e) { log(e.name, String(e.message).slice(0, 50)); } };
var x = new Number(-1.1); log(+x, x + 1, x * 2, x - 1, x + "", -x, x < 0, x == -1.1);
var y = new Number(-1.1); y++; log(y); var z = new Number(1.1); var w = z++; log(w, z);
log(new Number(NaN) + "", new Number(2.5).valueOf(), Number(new Number(2.5)), new Number(3).toFixed(1));
var b = new Boolean(false); log(b ? "t" : "f", b == false, b + 1);
var s = new String("ab"); log(s + "c", s.length, s == "ab", typeof s);
function f1() { return 0; }
log(typeof (f1 + 1), (f1 + 1) === f1.toString() + 1, f1 + "" === f1.toString(), `${f1}` === f1.toString(), ({} > f1) === ({}.toString() > f1.toString()));
log(({}).toString === Object.prototype.toString, ({ x: 1 }).toString === Object.prototype.toString, [].concat === Array.prototype.concat, (1).toFixed === Number.prototype.toFixed, "".trim === String.prototype.trim);
log(({ [Symbol.toPrimitive](h) { return h; } }) == "default", 1 == ({ valueOf() { return 1; } }), ({ [Symbol.toPrimitive]: (h) => h }) + "", `${{ [Symbol.toPrimitive]: (h) => h }}`, +({ [Symbol.toPrimitive]: (h) => (h === "number" ? 7 : 0) }));
for (const k of ["NaN", "MAX_VALUE", "MIN_VALUE", "NEGATIVE_INFINITY", "POSITIVE_INFINITY", "EPSILON", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER"]) log(k, Number[k], typeof Number[k], k in Number);
log(typeof String.prototype.length, String.prototype.length, Array.prototype.length, Function.prototype.length, typeof Function.prototype.name);
const tn = (f) => { try { log("ok", f()); } catch (e) { log(e.name); } };
tn(() => "toString" in true); tn(() => "x" in 1); tn(() => "x" in "s"); tn(() => "x" in null);
for (const k of ["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT1_2", "SQRT2"]) { tn(() => { Math[k] = 1; return Math[k]; }); tn(() => delete Math[k]); }
tn(() => { Number.MAX_VALUE = 1; }); tn(() => delete Number.NaN); tn(() => { undefined = 1; }); tn(() => { NaN = 1; }); tn(() => { Infinity = 1; });
tn(() => delete null.x); tn(() => delete undefined["x"]);
t(() => new Date(5).getTime());
log(`a\
b`.length);
const tpl = (s) => s; const to = tpl`a${1}b`; log(Object.isFrozen(to), Object.isFrozen(to.raw));
const dup = { get foo() { return 1; }, foo: 2 }; log(dup.foo, Object.getOwnPropertyDescriptor(dup, "foo").value);
const dup2 = { foo: 1, get foo() { return 2; } }; log(dup2.foo);
const dup3 = { get foo() { return 1; }, set foo(v) {}, foo: 3 }; log(dup3.foo);
function N1() { return new.target; } class N2 {} log(Reflect.construct(N1, [], N2) === N2 || "x", Object.getPrototypeOf(Reflect.construct(N1, [], N2)) === Object.prototype);
function N3() { this.t = new.target; } const r3 = Reflect.construct(N3, [], N2); log(r3.t === N2, r3 instanceof N2, r3 instanceof N3);
class B0 { constructor() { this.nt = new.target; } } class B1 extends B0 {} log(new B1().nt === B1, Reflect.construct(B0, [], B1).nt === B1, Reflect.construct(B0, [], B1) instanceof B1);
const kobj = { [Symbol.toPrimitive]() { return "pk"; } }; class K1 { [kobj]() { return 1; } static [kobj] = 2; } log(typeof K1.prototype.pk, K1.pk); log({ [kobj]: 3 }.pk);
const kbad = { toString() { return {}; }, valueOf() { return {}; } }; t(() => { class X { [kbad]() {} } }); t(() => ({ [kbad]: 1 })); t(() => ({}[kbad])); t(() => { const o = {}; o[kbad] = 1; });
const ksym = { [Symbol.toPrimitive]() { return Symbol.iterator; } }; t(() => typeof ({ [ksym]: 1 })[Symbol.iterator]);
log(Object.prototype.__lookupGetter__ !== undefined, typeof ({ get a() { return 1; } }).__lookupGetter__("a"));
const od = {}; od.__defineGetter__("g", () => 5); od.__defineSetter__("g", () => {}); log(od.g, typeof od.__lookupSetter__("g"));
