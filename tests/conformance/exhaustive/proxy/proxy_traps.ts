// Proxy — all property/enumeration traps plus apply/construct. A handler trap
// that is absent falls through to the default operation on the target; a trap
// that is present is invoked with (target, key[, value|receiver]). Enumeration
// (Object.keys / for-in / JSON.stringify) and nested proxies route through the
// trap dispatch too.
function main(): void {
  // get: present and fallthrough
  const g: any = new Proxy({ a: 1 }, { get(t: any, k: any) { return k in t ? t[k] : 99; } });
  console.log(g.a, g.z); // 1 99
  const g2: any = new Proxy({ a: 1, b: 2 }, {});
  console.log(g2.a, g2.b); // 1 2 (no trap -> target)

  // get with computed key + receiver
  const gr: any = new Proxy({} as any, { get(_t: any, k: any, r: any) { return String(k) + ":" + (r === gr); } });
  console.log(gr.x, gr["y"]); // x:true y:true

  // set: trap records and writes through
  const log: string[] = [];
  const s: any = new Proxy({} as any, { set(t: any, k: any, v: any) { log.push(k + "=" + v); t[k] = v; return true; } });
  s.x = 5;
  console.log(log.join(","), s.x); // x=5 5

  // has: synthesise a virtual property
  const h: any = new Proxy({ a: 1 } as any, { has(t: any, k: any) { return k === "magic" || k in t; } });
  console.log("magic" in h, "a" in h, "z" in h); // true true false

  // deleteProperty
  const dl: string[] = [];
  const d: any = new Proxy({ a: 1 } as any, { deleteProperty(_t: any, k: any) { dl.push(String(k)); return true; } });
  const dr = delete d.a;
  console.log(dl.join(","), dr); // a true

  // ownKeys / enumeration: Object.keys, for-in, JSON, Object.entries
  const e: any = new Proxy({ x: 1, y: 2, z: 3 }, {});
  console.log(Object.keys(e).join(",")); // x,y,z
  let forin = "";
  for (const k in e) forin += k;
  console.log(forin); // xyz
  const jp: any = new Proxy({ a: 1, b: 2 }, { get(t: any, k: any) { return t[k] * 10; } });
  console.log(JSON.stringify(jp)); // {"a":10,"b":20}
  console.log(JSON.stringify(Object.entries(e))); // [["x",1],["y",2],["z",3]]

  // getPrototypeOf / setPrototypeOf
  const proto: any = { tag: 7 };
  const gp: any = new Proxy({} as any, { getPrototypeOf() { return proto; } });
  console.log(Object.getPrototypeOf(gp) === proto); // true

  // isExtensible / preventExtensions / getOwnPropertyDescriptor / defineProperty
  const ie: any = new Proxy({}, { isExtensible(t: any) { return Reflect.isExtensible(t); } });
  console.log(Reflect.isExtensible(ie)); // true
  const od: any = new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { return { value: 42, configurable: true, enumerable: true }; } });
  console.log((Object.getOwnPropertyDescriptor(od, "a") as any).value); // 42

  // apply (callable proxy)
  const fp: any = new Proxy(function (a: number, b: number) { return a + b; }, {
    apply(t: any, _thiz: any, args: any) { return t(...args) * 2; },
  });
  console.log(fp(3, 4)); // 14

  // construct (constructor proxy) — both the trap and the default fallthrough
  class Point { x: number; constructor(v: number) { this.x = v; } }
  const cp: any = new Proxy(Point, { construct(t: any, args: any) { const o = new t(...args); o.x += 100; return o; } });
  console.log(new cp(5).x); // 105
  const cp2: any = new Proxy(Point, {});
  console.log(new cp2(7).x); // 7

  // nested proxies
  const inner: any = new Proxy({ v: 1 }, { get() { return 7; } });
  const outer: any = new Proxy(inner, {});
  console.log(outer.v); // 7
}
main();
