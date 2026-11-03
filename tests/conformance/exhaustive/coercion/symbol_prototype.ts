// @ts-nocheck
// Symbol.prototype: a symbol held in an `any` reads its members there, Object(sym) wraps it, == sees through the
// wrapper. await of a thenable whose `then` getter throws leaves no unhandled rejection behind.
const log = (...a) => console.log(...a);
const s = Symbol("foo");
const any = [s][0];
log(any.toString(), any.description, any.valueOf() === s, typeof any.toString);
log(Symbol.prototype.toString.call(s), Symbol.prototype.valueOf.call(s) === s, Object.getOwnPropertyNames(Symbol.prototype).sort().join());
log(Symbol.prototype[Symbol.toStringTag], Symbol.prototype[Symbol.toPrimitive].name, Symbol.prototype[Symbol.toPrimitive].call(s) === s);
log(Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get.name);
try { Symbol.prototype.toString.call({}); } catch (e) { log(e.name); }
try { Symbol.prototype.description; } catch (e) { log(e.name); }
const w = Object(s);
log(typeof w, w instanceof Symbol, w == s, s == w, w === s, w.description, w.toString(), w.valueOf() === s);
log(Object.prototype.toString.call(w), Object.prototype.toString.call(s));
try { w + ""; } catch (e) { log(e.name); }
log(({ [w]: 1 })[s], Symbol("x").description, Symbol().description);
const o = { i: Symbol("in a literal"), n: null };
const spread = { ...o };
log(spread.i.toString(), spread.i.description, "description" in Symbol.prototype);
log(Symbol.prototype.constructor === Symbol, Object.getPrototypeOf(Symbol.prototype) === Object.prototype);
log(Promise.prototype === Object.getPrototypeOf(Promise.resolve(1)), typeof Promise.prototype.then);

var reason = { r: 1 };
async function plain() { await { get then() { throw reason; } }; }
plain().catch((v) => log("plain", v === reason));
async function* g2() { await { get then() { throw reason; } }; }
g2().next().catch((v) => log("generator", v === reason));
const star = { [Symbol.asyncIterator]() { return { next() { return { get then() { throw reason; } }; } }; } };
(async function* () { yield* star; })().next().catch((v) => log("yield*", v === reason));
