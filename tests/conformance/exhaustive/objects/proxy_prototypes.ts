// A Proxy on an ordinary object's prototype chain: the object's [[Get]],
// [[Has]], [[Set]] and method calls reach the proxy's traps (with the
// original object as the receiver), or the target's ordinary behaviour when
// the trap is missing; instanceof and isPrototypeOf walk through the proxy's
// getPrototypeOf.
const log: string[] = [];
const target: any = { k: 1, shared: "target", method() { return "m:" + (this as any).tag; } };
Object.defineProperty(target, "getter", { get() { return "getter:" + (this as any).tag; } });
const handler: ProxyHandler<any> = {
  get(t, key, receiver) {
    if (key === "k") return 2;
    if (key === "viaTrap") return "trap:" + (receiver as any).tag;
    return Reflect.get(t, key, receiver);
  },
  has(t, key) { log.push("has " + String(key)); return key === "virtual" || key in t; },
  set(t, key, value, receiver) {
    log.push("set " + String(key));
    if (key === "intercepted") return true;
    return Reflect.set(t, key, value, receiver);
  },
};
const proxy = new Proxy(target, handler);

function main(): void {
  // reads through the trap and through Reflect.get with the receiver
  const o: any = Object.create(proxy);
  o.tag = "o";
  console.log(o.k, o.shared, o.viaTrap, o.getter, o.method(), o.missing);
  console.log("tag" in o, "virtual" in o, "k" in o, "nothing" in o);
  // writes: an own property on the receiver, an intercepted key
  o.fresh = 5;
  o.intercepted = 6;
  console.log(Object.keys(o).join(","), o.fresh, o.intercepted, target.fresh, log.join("|"));
  // an existing own property does not consult the chain
  o.tag = "o2"; console.log(o.tag, log.length);

  // a proxy without traps behaves like its target, receiver kept
  const plainProxy = new Proxy({ base: 10, get viaThis() { return (this as any).own; } } as any, {});
  const q: any = Object.create(plainProxy);
  q.own = 20;
  console.log(q.base, q.viaThis, "base" in q, q.nope);
  q.base = 11; console.log(q.base, plainProxy.base, Object.keys(q).join(","));

  // deeper: object -> ordinary -> proxy -> ordinary with the key
  const bottom: any = { deep: "bottom" };
  const midProxy = new Proxy(Object.create(bottom), {});
  const top: any = Object.create(midProxy);
  const leaf: any = Object.create(top);
  console.log(leaf.deep, "deep" in leaf);

  // instanceof and isPrototypeOf through a getPrototypeOf trap
  class Base { hello() { return "hi"; } }
  const viaProto = new Proxy({}, { getPrototypeOf() { return Base.prototype; } });
  const inst: any = Object.create(viaProto);
  console.log(inst instanceof Base, Base.prototype.isPrototypeOf(inst), Object.prototype.isPrototypeOf(inst));

  // a revoked proxy on the chain throws on the next lookup
  const { proxy: rp, revoke } = Proxy.revocable({ r: 1 } as any, {});
  const rv: any = Object.create(rp);
  console.log(rv.r);
  revoke();
  try { console.log(rv.r); } catch (e) { console.log("revoked", (e as Error).name); }

  // dynamic keys and a loop at one site
  let sum = 0;
  const keys = ["k", "shared", "missing", "k"];
  for (let i = 0; i < 8; i++) { const v = o[keys[i & 3]]; sum += typeof v === "number" ? v : 100; }
  console.log(sum);
}
main();
