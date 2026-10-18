// Fixed-key stores that add a property to a fresh object are cached per
// (site, hidden class). Every invalidation source must still be honored:
// inherited setters defined later, prototype relinks, non-extensible
// receivers, dictionary-mode receivers after deletion, and collections.
function build(i: number): any {
  const o: any = {};
  o.a = i;
  o.b = i * 2;
  o.c = "c" + i;
  o.d = i % 3 === 0 ? null : undefined;
  return o;
}

function wide(i: number): any {
  const o: any = {};
  o.k0 = i; o.k1 = i + 1; o.k2 = i + 2; o.k3 = i + 3; o.k4 = i + 4; o.k5 = i + 5;
  o.k6 = i + 6; o.k7 = i + 7; o.k8 = i + 8; o.k9 = i + 9; o.k10 = i + 10; o.k11 = i + 11;
  return o;
}

function setB(o: any, v: number): void { o.b = v; }

class Sized { x = 1; y = 2; }

function main(): void {
  // steady-state additions keep key order and values
  let sum = 0;
  let order = "";
  for (let i = 0; i < 5000; i++) {
    const o = build(i);
    sum += o.a + o.b;
    if (i === 4999) order = Object.keys(o).join("|") + " " + o.c + " " + o.d;
    if (i % 500 === 0) { const junk: any[] = []; for (let j = 0; j < 2000; j++) junk.push({ j }); }
  }
  console.log(sum, order);

  // many keys: the index-backed representation is reached through the cache
  let wsum = 0;
  let wkeys = "";
  for (let i = 0; i < 300; i++) {
    const w = wide(i);
    wsum += w.k0 + w.k11;
    if (i === 299) wkeys = Object.keys(w).join("|");
  }
  console.log(wsum, wkeys);

  // polymorphic site: receivers with different pre-existing keys
  const p1: any = {}; const p2: any = { z: 1 }; const p3: any = { y: 1, z: 2 };
  for (let r = 0; r < 3; r++) { setB(p1, r); setB(p2, r); setB(p3, r); }
  for (let r = 0; r < 20; r++) { const q: any = r % 2 ? {} : { z: 0 }; setB(q, r); if (r === 19) console.log(Object.keys(q).join("|"), q.b); }
  console.log(Object.keys(p1).join("|"), Object.keys(p2).join("|"), Object.keys(p3).join("|"), p1.b, p2.b, p3.b);

  // an inherited setter defined AFTER the site warmed up must be invoked
  const log: number[] = [];
  Object.defineProperty(Object.prototype, "b", {
    set(this: any, v: number) { log.push(v); this.viaSetter = v; },
    configurable: true,
  });
  const s1 = build(1);
  console.log(log.join(","), s1.viaSetter, Object.keys(s1).join("|"), s1.b);
  delete (Object.prototype as any).b;
  const s2 = build(2);
  console.log(log.length, Object.keys(s2).join("|"), s2.b);

  // a prototype relink to a chain with a setter, between cached additions
  const withSetter: any = {};
  Object.defineProperty(withSetter, "b", { set(this: any, v: number) { this.relinked = v; }, configurable: true });
  const t: any = {};
  Object.setPrototypeOf(t, withSetter);
  setB(t, 77);
  console.log(Object.keys(t).join("|"), t.relinked, Object.getPrototypeOf(t) === withSetter);

  // non-extensible receivers throw in strict mode even on a warm site
  const frozen: any = Object.freeze({});
  try { setB(frozen, 1); console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError, e.message); }
  const sealed: any = Object.preventExtensions({});
  try { setB(sealed, 1); console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError, e.message); }

  // deletion moves the receiver out of the cached hidden class
  const dd: any = { a: 1 };
  delete dd.a;
  setB(dd, 5);
  setB(dd, 6);
  console.log(Object.keys(dd).join("|"), dd.b, "a" in dd);

  // sized class instances take the uncached path
  const sized: any[] = [];
  for (let i = 0; i < 50; i++) { const s: any = new Sized(); s.b = i; s.extra = i * 3; sized.push(s); }
  console.log(sized[49].x, sized[49].b, sized[49].extra, Object.keys(sized[49]).join("|"));

  // accessor on the direct prototype installed before the first addition
  const base: any = {};
  let hits = 0;
  Object.defineProperty(base, "b", { set(this: any, v: number) { hits += v; }, configurable: true });
  for (let i = 0; i < 10; i++) { const o: any = Object.create(base); setB(o, 1); if (i === 9) console.log(Object.keys(o).length, hits); }
}
main();
