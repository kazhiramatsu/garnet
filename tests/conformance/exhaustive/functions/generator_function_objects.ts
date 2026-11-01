// @ts-nocheck
// A generator function's `prototype`, the prototype of what it makes; the objects generator and async functions
// inherit from.
const log = (...a) => console.log(...a);
function* g() { yield 1; }
const GenProto = Object.getPrototypeOf(function* () {}).prototype;
log(typeof g.prototype, g() instanceof g, Object.getPrototypeOf(g()) === g.prototype);
log(Object.getPrototypeOf(g.prototype) === GenProto, Object.getOwnPropertyNames(g.prototype).length);
log(Object.getPrototypeOf(g) !== Function.prototype, Object.getPrototypeOf(Object.getPrototypeOf(g)) === Function.prototype);
log(JSON.stringify(Object.getOwnPropertyDescriptor(g, "prototype")), g.hasOwnProperty("prototype"));
log(g.prototype !== (function* () {}).prototype);
const it = g(); log(it instanceof g);                 // made before `prototype` was ever read elsewhere
function* late() { yield 2; }
const made = late(); log(made instanceof late, [...made]);
g.prototype = null;
log(Object.getPrototypeOf(g()) === GenProto);
const other = { mine: 1 }; g.prototype = other;
log(g().mine, Object.getPrototypeOf(g()) === other);
log(Object.prototype.toString.call(function* () {}), Object.prototype.toString.call(async function () {}), Object.prototype.toString.call(async function* () {}));
log(typeof g.call, typeof g.bind, g.length, g.name);
const o = { *m() { yield 3; } };
log(o.m.hasOwnProperty("prototype"), Object.getPrototypeOf(o.m.prototype) === GenProto, o.m() instanceof o.m);
class C { *m() { yield 4; } static *s() { yield 5; } }
log(C.prototype.m.hasOwnProperty("prototype"), new C().m() instanceof C.prototype.m, C.s() instanceof C.s);
try { new g(); } catch (e) { log(e.name); }

async function* ag() { yield 1; }
const AsyncGenProto = Object.getPrototypeOf(async function* () {}).prototype;
log(typeof ag.prototype, ag() instanceof ag, Object.getPrototypeOf(ag.prototype) === AsyncGenProto, AsyncGenProto !== GenProto);
ag.prototype = null;
log(Object.getPrototypeOf(ag()) === AsyncGenProto);

async function af() {}
const AsyncFnProto = Object.getPrototypeOf(af);
log(AsyncFnProto !== Function.prototype, Object.getPrototypeOf(AsyncFnProto) === Function.prototype, af.hasOwnProperty("prototype"), af.prototype);
log(Object.getPrototypeOf(async () => {}) === AsyncFnProto, Object.getPrototypeOf(() => {}) === Function.prototype);
log(AsyncFnProto[Symbol.toStringTag], typeof af.call, af.call(null) instanceof Promise);
for (const x of [1]) { const inner = function* () { yield x; }; log(inner() instanceof inner, [...inner()]); }
