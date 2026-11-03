// @ts-nocheck
const log = [];
const res = (name, fail) => ({ name, [Symbol.dispose]() { log.push("dispose " + name); if (fail) throw new Error("fail " + name); } });
const ares = (name) => ({ name, async [Symbol.asyncDispose]() { log.push("adispose " + name); } });
const flush = () => { const r = log.join(); log.length = 0; return r; };
{
  using a = res("a"), b = res("b");
  log.push("body " + a.name + b.name);
}
console.log(flush());
function early() { using x = res("x"); return "ret " + x.name; }
console.log(early(), flush());
try { (() => { using x = res("x"); throw new Error("body"); })(); } catch (e) { console.log(e.message, flush()); }
try { (() => { using x = res("x", true); throw new Error("body"); })(); } catch (e) { console.log(e.constructor.name, e.error.message, e.suppressed.message, e instanceof SuppressedError, e instanceof Error, flush()); }
try { (() => { using x = res("x", true), y = res("y", true); })(); } catch (e) { console.log(e.name, e.error.message, e.suppressed.message, flush()); }
for (using r of [res("1"), res("2")]) log.push("loop " + r.name);
console.log(flush());
for (using i = res("i"); log.length < 1;) log.push("iter");
console.log(flush());
switch (1) { case 1: using s = res("s"); log.push("case"); break; default: log.push("no"); }
console.log(flush());
{ using n = null, u = undefined; log.push("null ok"); }
console.log(flush());
try { using bad = {}; } catch (e) { console.log(e.name); }
try { using bad = 1; } catch (e) { console.log(e.name); }
try { using bad = { [Symbol.dispose]: 1 }; } catch (e) { console.log(e.name); }
function hoist() { const v = later(); using a = res("h"); function later() { return "hoisted"; } return v; }
console.log(hoist(), flush());
function* gen() { using g = res("g"); yield 1; yield 2; }
const it = gen(); it.next(); it.return(5); console.log(flush());
const typed = (): number => { using t: { n: number } & Disposable = { n: 41, [Symbol.dispose]() {} }; return t.n + 1; };
console.log(typed());
async function asyncCase() {
  {
    await using a = ares("a"), b = res("b");
    log.push("abody");
  }
  console.log(flush());
  { await using n = null; log.push("after null"); }
  console.log(flush());
  for (await using x of [ares("f")]) log.push("floop");
  console.log(flush());
  try { await using x = { [Symbol.asyncDispose]() { throw new Error("ad"); } }; } catch (e) { console.log(e.message); }
  const s = new AsyncDisposableStack();
  s.use(ares("u")); s.defer(() => { log.push("defer"); }); s.adopt("v", (v) => { log.push("adopt " + v); });
  console.log(s.disposed);
  await s.disposeAsync();
  console.log(s.disposed, flush());
}
const st = new DisposableStack();
st.use(res("u")); st.defer(() => log.push("defer")); console.log(st.adopt(5, (v) => log.push("adopt" + v)));
const moved = st.move(); console.log(st.disposed, moved.disposed);
moved.dispose(); console.log(moved.disposed, flush());
console.log(typeof DisposableStack.prototype[Symbol.dispose], DisposableStack.prototype[Symbol.dispose] === DisposableStack.prototype.dispose, Object.prototype.toString.call(st), SuppressedError.length, SuppressedError("a", "b", "c").message, new SuppressedError(1, 2).hasOwnProperty("message"));
try { st.use({}); } catch (e) { console.log(e.name); }
const itd = [1][Symbol.iterator](); console.log(typeof itd[Symbol.dispose]);
asyncCase();
