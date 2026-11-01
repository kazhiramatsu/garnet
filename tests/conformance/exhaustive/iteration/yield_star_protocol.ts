// @ts-nocheck
const log = (...a) => console.log(...a);
const trace = [];
const mkIter = () => ({
  [Symbol.iterator]() { return this; },
  next(...a) { trace.push("next:" + a.length + ":" + a[0]); return { value: "n", get done() { trace.push("done"); return trace.length > 12; } }; },
  return(...a) { trace.push("return:" + a.length + ":" + a[0]); return { value: "r", done: true }; },
  throw(...a) { trace.push("throw:" + a.length + ":" + a[0]); return { value: "t", done: false }; },
});
function* g() { const r = yield* mkIter(); trace.push("after:" + r); return "end"; }
const it = g();
log(JSON.stringify(it.next("ignored")));
log(JSON.stringify(it.next("sent")));
log(JSON.stringify(it.throw("oops")));
log(JSON.stringify(it.return("bye")));
log(trace.join());
// the inner result object is handed on
const res = { value: 1, done: false };
function* g2() { yield* { [Symbol.iterator]() { return { next() { return res; } }; } }; }
log(g2().next() === res);
// no throw method: closed, TypeError
trace.length = 0;
function* g3() { yield* { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { trace.push("closed"); return {}; } }; } }; }
const i3 = g3(); i3.next();
try { i3.throw(new RangeError("x")); } catch (e) { log(e.name, trace.join()); }
// no return method
function* g4() { try { yield* { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; } }; } }; } finally { trace.push("fin"); } }
const i4 = g4(); i4.next(); log(JSON.stringify(i4.return(9)), trace.join());
// return not done: keeps going
function* g5() { const v = yield* { [Symbol.iterator]() { let n = 0; return { next() { return { value: n++, done: false }; }, return(x) { return { value: x + 1, done: n++ > 2 }; } }; } }; }
const i5 = g5(); log(JSON.stringify(i5.next()), JSON.stringify(i5.return(10)), JSON.stringify(i5.return(20)), JSON.stringify(i5.return(30)), JSON.stringify(i5.next()));
// non-object results
function* g6() { yield* { [Symbol.iterator]() { return { next() { return 1; } }; } }; }
try { g6().next(); } catch (e) { log(e.name); }
// delegating to generators, values through
function* a1() { const x = yield 1; log("x", x); try { yield 2; } finally { log("cleanup"); } return 3; }
function* a2() { const r = yield* a1(); log("r", r); yield r * 2; }
const i6 = a2(); log(JSON.stringify(i6.next()), JSON.stringify(i6.next("v")), JSON.stringify(i6.next()), JSON.stringify(i6.next()));
const i7 = a2(); i7.next(); i7.next(); log(JSON.stringify(i7.return(5)), JSON.stringify(i7.next()));
const i8 = a2(); i8.next(); i8.next(); try { i8.throw(new Error("e")); } catch (e) { log(e.message); }
// async
const atrace = [];
const asyncIter = {
  [Symbol.asyncIterator]() { atrace.push("get"); return this; },
  next(...a) { atrace.push("next:" + a.length); return { then(res) { atrace.push("then"); res({ value: "v", done: atrace.length > 8 }); } }; },
  return(...a) { atrace.push("return:" + a.length); return { value: "rv", done: true }; },
  throw(...a) { atrace.push("throw:" + a.length); return { value: "tv", done: false }; },
};
async function* ag() { const r = yield* asyncIter; return r; }
(async () => {
  const i = ag();
  log(JSON.stringify(await i.next(1)));
  log(JSON.stringify(await i.throw(2)));
  log(JSON.stringify(await i.next(3)));
  log(JSON.stringify(await i.return(4)));
  log(atrace.join());
  async function* ag2() { yield* [Promise.resolve(1), 2]; }
  const j = ag2(); log(JSON.stringify(await j.next()), JSON.stringify(await j.next()), JSON.stringify(await j.next()));
  async function* ag3() { yield* { [Symbol.asyncIterator]: 1 }; }
  try { await ag3().next(); } catch (e) { log(e.name); }
  async function* ag4() { yield* { [Symbol.asyncIterator]() { return 1; } }; }
  try { await ag4().next(); } catch (e) { log(e.name); }
  async function* ag5() { yield* { [Symbol.asyncIterator]: null, [Symbol.iterator]() { return { next() { return { value: Promise.resolve(7), done: true }; } }; } }; }
  log(JSON.stringify(await ag5().next()));
  async function* ag6() { const v = yield* (async function* () { yield 1; return 2; })(); yield v; }
  const k = ag6(); log(JSON.stringify(await k.next()), JSON.stringify(await k.next()), JSON.stringify(await k.next()));
})();

function* overNumber() { yield* (5 as any); }
try { for (const x of overNumber()) log(x); } catch (e: any) { log(e instanceof TypeError); }
