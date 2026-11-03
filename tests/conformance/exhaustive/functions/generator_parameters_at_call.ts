// @ts-nocheck
// a generator's parameters bind at the call, ahead of its first next()
var log = [];
const eff = (s, v) => { log.push(s); return v; };
function* g1(a = eff("a", 1), { b } = eff("b", { b: 2 }), [c] = eff("c", [3])) { log.push("body"); yield a + b + c; }
const it = g1();
log.push("after call");
console.log(log.join(), JSON.stringify(it.next()), log.join());
log = [];
function* g2(x = (() => { throw new RangeError("param"); })()) { yield 1; }
try { g2(); console.log("no throw"); } catch (e) { console.log(e.name, e.message); }
function* g3({ p }) { yield p; }
try { g3(null); console.log("no throw"); } catch (e) { console.log(e.name); }
function* g4([p]) { yield p; }
try { g4({}); console.log("no throw"); } catch (e) { console.log(e.name); }
const iterThrows = { [Symbol.iterator]() { throw new SyntaxError("iter"); } };
try { g4(iterThrows); console.log("no throw"); } catch (e) { console.log(e.name, e.message); }
// the generator has not started: throw and return finish it without running the body
const it2 = g1();
try { it2.throw(new Error("x")); } catch (e) { console.log(e.message); }
console.log(JSON.stringify(it2.next()));
const it3 = g1();
console.log(JSON.stringify(it3.return(5)), JSON.stringify(it3.next()));
// next's first argument is dropped, a later one reaches the yield
function* g5(a = 1) { const r = yield a; yield r; }
const it5 = g5();
console.log(JSON.stringify(it5.next(99)), JSON.stringify(it5.next(7)), JSON.stringify(it5.next()));
// captured parameters, this, arguments
const o = { n: 10, *m(a = this.n, b = () => a + 1) { yield arguments.length; yield a; yield b(); } };
console.log([...o.m()].join(), [...o.m(5)].join());
class C { static *s(x = 2) { yield x * 2; } *i(y = 3) { yield y; } }
console.log([...C.s()].join(), [...new C().i()].join());
// a finally around the first yield is not active at the call
function* g6(a = 1) { try { yield a; } finally { log.push("fin"); } }
const it6 = g6(); console.log(JSON.stringify(it6.return(2)), log.join());
const it7 = g6(); it7.next(); console.log(JSON.stringify(it7.return(2)), log.join());
// async generators: the call throws, it does not reject
async function* ag1(a = (() => { throw new TypeError("ag"); })()) { yield a; }
try { ag1(); console.log("no throw"); } catch (e) { console.log(e.name, e.message); }
async function* ag2({ q }) { yield q; }
try { ag2(undefined); console.log("no throw"); } catch (e) { console.log(e.name); }
log = [];
async function* ag3(a = eff("ag3", 1)) { log.push("body"); yield a; yield a + 1; }
const ai = ag3();
log.push("after call");
console.log(log.join());
ai.next().then((r) => { console.log(JSON.stringify(r), log.join()); return ai.next(); }).then((r) => { console.log(JSON.stringify(r)); return ai.next(); }).then((r) => console.log(JSON.stringify(r)));
// async functions reject
async function af1(a = (() => { throw new TypeError("af"); })()) { return a; }
af1().catch((e) => console.log("rejected", e.name, e.message));
const ah = async (a = (() => { throw new TypeError("ah"); })()) => a;
ah().catch((e) => console.log("rejected", e.name, e.message));
