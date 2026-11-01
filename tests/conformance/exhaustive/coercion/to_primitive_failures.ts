// @ts-nocheck
const log = (...a) => console.log(...a);
const t = (f) => { try { log("ok", f()); } catch (e) { log(e.name, String(e.message).slice(0, 50)); } };
var callCount = 0;
new function (obj) { log(obj.a, obj.b, Object.keys(obj).length); callCount += 1; }({ a: 1, b: 2, ...null });
log(callCount);
new function (a, b) { log(a, b, arguments.length); }(...[1, 2], 3);
const o2 = new function () { this.x = 1; }; log(o2.x);
// ToPrimitive failures
var object = { valueOf: function () { return {}; }, toString: function () { return {}; } };
t(() => ~object); t(() => -object); t(() => +object); t(() => object + 1); t(() => object * 2); t(() => object < 1); t(() => `${object}`); t(() => object == 1); t(() => String(object));
t(() => { let x = object; x++; return x; });
// exponent order
var trace = "";
const lhs = () => { trace += "1"; return { valueOf() { trace += "3"; return 2; } }; };
const rhs = () => { trace += "2"; return { valueOf() { trace += "4"; return 3; } }; };
log(lhs() ** rhs(), trace);
t(() => { trace = ""; return lhs() ** Symbol(); });
t(() => { trace = ""; return Symbol() ** lhs(); });
t(() => { return 2 ** Object(Symbol()); });
for (const op of ["*", "/", "%", "-", "&", "|", "^", "<<", ">>", ">>>"]) {
  const f = { "*": (a, b) => a * b, "/": (a, b) => a / b, "%": (a, b) => a % b, "-": (a, b) => a - b, "&": (a, b) => a & b, "|": (a, b) => a | b, "^": (a, b) => a ^ b, "<<": (a, b) => a << b, ">>": (a, b) => a >> b, ">>>": (a, b) => a >>> b }[op];
  trace = ""; const r = f(lhs(), rhs()); log(op, r, trace);
  t(() => f(Symbol(), lhs())); t(() => f(1, Symbol()));
}
// spread objects
const s1 = { ...{ toString: 1 } }; log(s1.toString);
const arr = [...[1], ...{ *[Symbol.iterator]() { yield 2; } }]; log(arr.join());
const obj3 = { toString() { return "x"; } }; log(`${obj3}`, obj3 + "", [obj3].join());
log(String([{ toString() { return "y"; } }]));
