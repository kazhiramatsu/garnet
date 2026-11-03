// @ts-nocheck
const out = [];
const show = (n, v) => console.log(n, JSON.stringify(v));
class P extends Promise { static count = 0; constructor(ex) { super(ex); P.count++; } }
async function main() {
  const a = P.resolve(1);
  show("sub", [a instanceof P, a.then((x) => x) instanceof P, a.catch(() => 0) instanceof P, a.finally(() => 0) instanceof P, P.all([1]) instanceof P, P.race([1]) instanceof P, P.allSettled([1]) instanceof P, P.any([1]) instanceof P, P.reject(1).catch(() => 0) instanceof P]);
  show("values", [await P.all([1, Promise.resolve(2)]), await P.allSettled([1, Promise.reject(2)]), await P.race([1]), await P.any([Promise.reject(1), 2])]);
  try { await P.any([Promise.reject(1)]); } catch (e) { show("any", [e.name, e.errors, e.message]); }
  try { await Promise.any([]); } catch (e) { show("any empty", [e.name, e.errors]); }
  let thenCalls = 0;
  const p = Promise.resolve(1); p.then = function (...args) { thenCalls++; return Promise.prototype.then.apply(this, args); };
  await Promise.all([p, p]);
  show("then calls", thenCalls);
  const orig = Promise.resolve; let rc = 0;
  Promise.resolve = function (v) { rc++; return orig.call(this, v); };
  await Promise.all([1, 2, 3]); Promise.resolve = orig;
  show("resolve calls", rc);
  function C(ex) { ex((v) => out.push("res" + v), (v) => out.push("rej" + v)); this.custom = true; }
  C.resolve = (v) => ({ then(f) { f(v); } });
  const r = Promise.all.call(C, [1]);
  show("custom", [r.custom, out]);
  show("try", [await Promise.try(() => 5), await Promise.try((a, b) => a + b, 1, 2), await Promise.try(() => { throw 1; }).catch((e) => e + 1)]);
  const wr = Promise.withResolvers(); wr.resolve(9); show("withResolvers", await wr.promise);
  show("close", await (async () => { let closed = 0; const it = { [Symbol.iterator]() { return { next() { return { done: false, value: 1 }; }, return() { closed++; return {}; } }; } }; const Bad = function (ex) { return new Promise(ex); }; Bad.resolve = () => { throw new Error("x"); }; try { await Promise.all.call(Bad, it); } catch (e) { return [e.message, closed]; } })());
  try { Promise.resolve.call(1); } catch (e) { show("non object", e.name); }
  try { Promise.all.call(1, []); } catch (e) { show("non ctor", e.name); }
  try { Promise.prototype.then.call({}); } catch (e) { show("then recv", e.name); }
  show("finally", [await Promise.resolve(1).finally(() => 2), await Promise.reject(1).finally(() => 2).catch((e) => e + 1)]);
  show("species", (() => { class Q extends Promise { static get [Symbol.species]() { return Promise; } } const q = Q.resolve(1); const t = q.then(() => 1); return [q instanceof Q, t instanceof Q, t instanceof Promise]; })());
}
main();
