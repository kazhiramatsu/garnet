// The trap cache (Session 356): a proxied operation resolves its trap through a per-name cache keyed by
// the handler cell, its class or shape word and the holder's shape. Every way a trap can change after
// the cache filled must be seen: a prototype method replaced in place, an intermediate prototype
// gaining the trap, an own property shadowing it and deleted again, the trap set to undefined, a
// relinked handler, a plain-object handler's trap reassigned and deleted, a handler shared by two
// proxies, an arrow trap (no `this`), an accessor trap, a non-callable trap, a revoked proxy.
class Base {
  get(t: any, k: string | symbol, r: any) { return "G:" + String(k) + ":" + String(Reflect.get(t, k, r)); }
}
class Mut extends Base {
  set(t: any, k: string | symbol, v: any, r: any) { (t as any)[k] = v; return true; }
  has(t: any, k: string | symbol) { return k in t; }
}
function main() {
  const out: string[] = [];
  const h = new Mut();
  const p: any = new Proxy({ a: 1, b: 2 }, h);
  const q: any = new Proxy({ a: 10 }, h);                 // the same handler behind a second proxy
  let s = "";
  for (let i = 0; i < 40; i++) { s += p.a; p.b = i; s += ("b" in p) ? "y" : "n"; s += q.a; }
  out.push(s.length + ":" + s.slice(0, 12) + ":" + s.slice(-12));
  (Base.prototype as any).get = function (t: any, k: any) { return "R:" + String(t[k]); };   // replaced in place
  out.push(p.a + " " + q.a);
  (Mut.prototype as any).get = function (t: any, k: any) { return "M:" + String(t[k]); };    // an intermediate prototype
  out.push(p.a + " " + q.a);
  (h as any).get = (t: any, k: any) => "own:" + String(t[k]);                                // an own property, an arrow
  out.push(p.a + " " + q.a);
  delete (h as any).get;
  out.push(p.a);
  (Mut.prototype as any).get = undefined;                                                    // no trap: the target's [[Get]]
  out.push(String(p.a) + " " + String(p.zz));
  Object.defineProperty(Mut.prototype, "get", { configurable: true, get() { return (t: any, k: any) => "acc:" + String(t[k]); } });
  out.push(p.a);                                                                            // an accessor trap: looked up each time
  delete (Mut.prototype as any).get;
  out.push(p.a);                                                                            // Base's replaced trap again
  const other = { get(t: any, k: any) { return "other:" + String(t[k]); } };
  Object.setPrototypeOf(h, other);                                                          // a relinked handler
  out.push(p.a + " " + q.a);
  Object.setPrototypeOf(h, Mut.prototype);
  out.push(p.a);
  // a plain-object handler
  const ph: any = { get(t: any, k: any) { return "P:" + String(t[k]); } };
  const pp: any = new Proxy({ a: 5 }, ph);
  let t = "";
  for (let i = 0; i < 30; i++) t += pp.a;
  ph.get = (tt: any, k: any) => "P2:" + String(tt[k]);
  t += "|" + pp.a;
  delete ph.get;
  t += "|" + pp.a;
  ph.get = 3;                                                                              // not callable
  try { t += pp.a; } catch (e) { t += "|" + (e instanceof TypeError); }
  ph.get = function (this: any, tt: any, k: any) { return "P3:" + (this === ph) + ":" + String(tt[k]); };
  t += "|" + pp.a;
  out.push(t);
  // a revocable proxy whose trap was cached
  const rev = Proxy.revocable({ a: 7 }, new Mut());
  let u = "";
  for (let i = 0; i < 20; i++) u += (rev.proxy as any).a;
  rev.revoke();
  try { u += (rev.proxy as any).a; } catch (e) { u += "|" + (e instanceof TypeError); }
  out.push(u.slice(-20));
  console.log(out.join("\n"));
}
main();
