// A read site's own absent record (docs/absent_reads_inline_design.md): the
// out-of-line read answers an absent key from the record before anything
// else, also for the reads of lazily linked frames. A record holds up to two
// receiver shapes that share one prototype chain and stays for its epoch.
// Each case reads at one site in a loop and changes something between
// iterations. A deletion leaves a prototype in dictionary mode, which no
// record or table entry covers afterwards, so every case has prototypes of
// its own and Object.prototype changes last.
interface Links { _brand?: any; type?: number; count?: number; target?: Links; name?: string; extra?: number; }
interface Bag { k?: number; other?: number; more?: number; tag?: string; length?: number; }
const pinned: object[] = [];
function heap<T extends object>(o: T): T { pinned.push(o); return o; }
let junk: number[][] = [];
function churn(n: number): void {
  for (let i = 0; i < n; i++) junk.push([i, i + 1]);
  if (junk.length > 4096) junk = [];
}
const L1 = class implements Links { declare _brand: any; };
const L3 = class implements Links { declare _brand: any; };
const L8 = class implements Links { declare _brand: any; };
// Readers whose only frame need is the read itself (lazily linked frames:
// the probe in line, then the linked out-of-line read).
function countOf(l: Links): number { const c = l.count; return c === undefined ? -1 : c; }
function sumCounts(ls: Links[]): number {
  let s = 0;
  for (let i = 0; i < ls.length; i++) { const c = ls[i].count; s += c === undefined ? 1 : 100 * c; }
  return s;
}
class Animal { speak(): string { return "animal"; } }
class Dog extends Animal { bark(): string { return "woof"; } }
interface Tok { pos: number; end: number; k: number | undefined; }
// A constructor function with a `this` parameter gives its prefix layout to
// `Tok`-typed reads (docs/static_slots_design.md): `t.k` is hinted at slot 2.
function Tok(this: Tok, pos: number, end: number) { this.pos = pos; this.end = end; this.k = pos + end; }
function readTokK(t: Tok): number | undefined { return t.k; }
function main(): void {
  // 1. three receiver shapes over one chain at one site (two fit the record),
  //    then the shared prototype gains the key, an accessor, loses it
  const s1: Links = heap(new L1()); s1.type = 1;
  const s2: Links = heap(new L1()); s2.name = "b";
  const s3: Links = heap(new L1()); s3.extra = 3;
  const ring = [s1, s2, s1, s2, s3, s1];
  const r1: unknown[] = [];
  for (let i = 0; i < 60; i++) {
    if (i === 20) (L1.prototype as Links).count = 7;
    if (i === 30) Object.defineProperty(L1.prototype, "count", { get() { return 8; }, configurable: true });
    if (i === 40) Object.defineProperty(L1.prototype, "count", { value: 9, writable: true, configurable: true });
    if (i === 50) delete (L1.prototype as Links).count;
    const v = ring[i % ring.length].count;
    if (i % 5 === 0 || (i >= 18 && i <= 22) || (i >= 28 && i <= 32) || (i >= 48 && i <= 52)) r1.push(v);
  }
  console.log("shapes", r1.join(","));

  // 2. the lazily linked readers: the record answers, then the chain changes
  //    underneath (a key on the prototype, an own key, a relinked receiver)
  const ls: Links[] = [];
  for (let i = 0; i < 40; i++) { const l: Links = new L3(); if (i % 3 === 0) l.type = i; else l.name = "n" + i; ls.push(l); }
  const r2: unknown[] = [];
  for (let round = 0; round < 8; round++) {
    if (round === 2) (L3.prototype as Links).count = 5;
    if (round === 3) (L3.prototype as Links).count = undefined;
    if (round === 5) ls[7].count = 9;
    if (round === 6) Object.setPrototypeOf(ls[8], { count: 4 });
    r2.push(sumCounts(ls), countOf(ls[7]), countOf(ls[8]), countOf(ls[9]));
  }
  console.log("lazy", r2.join(","));

  // 3. method calls through receivers whose methods live on the prototype
  //    (the field read is absent every time), then an own field shadows the
  //    method, then the prototypes' methods are replaced
  const dogs: Dog[] = [];
  for (let i = 0; i < 6; i++) dogs.push(heap(new Dog()));
  const r3: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    if (i === 10) (dogs[2] as any).speak = function () { return "own"; };
    if (i === 15) (Animal.prototype as any).speak = function () { return "replaced"; };
    if (i === 20) (Dog.prototype as any).speak = function () { return "dog"; };
    if (i === 25) delete (Dog.prototype as any).speak;
    const d = dogs[i % dogs.length];
    if (i % 2 === 0 || i === 21 || i === 26) r3.push(d.speak() + "/" + d.bark());
  }
  console.log("methods", r3.join(","));

  // 4. one dynamic-key site, alternating keys, some absent; then the
  //    receiver's prototype gains one of them
  const p4: Bag = heap({ tag: "p" });
  const d4 = heap(Object.create(p4) as Bag); d4.other = 1; d4.more = 2;
  const keys = ["k", "other", "length", "more", "k", "other"];
  const r4: unknown[] = [];
  for (let i = 0; i < 36; i++) {
    if (i === 24) Object.defineProperty(p4, "k", { value: 6, configurable: true });
    if (i === 30) p4.length = 44;
    r4.push((d4 as any)[keys[i % keys.length]]);
  }
  console.log("dynamic", r4.join(","));

  // 5. a plain object and an array with the same own keys and the same
  //    prototype chain at one dynamic-key site: the array's `length` is not
  //    a slot (a typed `.length` takes another path, so the key is dynamic)
  const p5: Bag = heap({ other: 0 });
  const o5 = heap(Object.create(p5) as Bag); o5.tag = "o";
  const a5: any = heap([1, 2, 3]); a5.tag = "a"; Object.setPrototypeOf(a5, p5);
  const lk = ["length", "k"];
  const r5: unknown[] = [];
  for (let i = 0; i < 24; i++) {
    if (i === 16) a5[3] = 4;
    r5.push(((i & 1) ? o5 : a5)[lk[(i >> 1) & 1]]);
  }
  console.log("arrays", r5.join(","));

  // 6. a proxy, then a function, inserted into the chain after absent reads
  const p6: Bag = heap({ other: 1 });
  const e = heap(Object.create(p6) as Bag);
  const r6: unknown[] = [];
  for (let i = 0; i < 12; i++) {
    if (i === 3) Object.setPrototypeOf(p6, new Proxy({}, { get(_t, key) { return key === "k" ? 41 : undefined; } }));
    if (i === 6) Object.setPrototypeOf(p6, Object.prototype);
    if (i === 8) Object.setPrototypeOf(p6, function k() {});
    if (i === 10) Object.setPrototypeOf(p6, null);
    r6.push(e.k, typeof (e as any).call);
  }
  console.log("exotic", r6.join(","));

  // 7. receivers frozen and sealed between reads; the prototype gains the key,
  //    then is turned into a dictionary
  const p7: Bag = heap({ other: 1, more: 2 });
  const f1 = heap(Object.create(p7) as Bag); f1.tag = "a";
  const f2 = heap(Object.create(p7) as Bag); f2.other = 5;
  const r7: unknown[] = [];
  for (let i = 0; i < 16; i++) {
    if (i === 3) Object.freeze(f1);
    if (i === 5) Object.seal(f2);
    if (i === 9) p7.k = 77;
    if (i === 11) delete p7.more;
    if (i === 13) delete p7.k;
    r7.push(((i & 1) ? f1 : f2).k);
  }
  console.log("integrity", r7.join(","), Object.isFrozen(f1), Object.isSealed(f2));

  // 8. collections between the reads (full collections move the epoch;
  //    receivers and prototypes are promoted and moved)
  const many: Links[] = [];
  for (let i = 0; i < 4000; i++) { const l: Links = new L8(); if (i & 1) l.type = i; else l.name = "m"; many.push(l); }
  let absent = 0, present = 0;
  for (let round = 0; round < 6; round++) {
    if (round === 4) (L8.prototype as Links).target = many[0];
    for (let i = 0; i < many.length; i++) { if (many[i].target === undefined) absent++; else present++; }
    churn(3000);
  }
  console.log("collections", absent, present, junk.length >= 0);

  // 9. hinted reads (static slots) of receivers that lack the key: built by
  //    the constructor, then objects of another layout, then the key on the
  //    latter's prototype
  const p9 = heap({} as Tok);
  const toks: Tok[] = [];
  for (let i = 0; i < 4; i++) toks.push(new (Tok as any)(i, i + 1) as Tok);
  for (let i = 0; i < 4; i++) { const t = heap(Object.create(p9) as Tok); t.pos = i; t.end = 2 * i; toks.push(t); }
  const r9: unknown[] = [];
  for (let round = 0; round < 6; round++) {
    if (round === 3) p9.k = -5;
    if (round === 4) p9.k = undefined;
    let sum = 0, miss = 0;
    for (const t of toks) { const v = t.k; if (v === undefined) miss++; else sum += v; }
    r9.push(sum + "/" + miss, readTokK(toks[5]));
  }
  console.log("static", r9.join(","));

  // 10. last: Object.prototype (the second link of class instances, the
  //     first of literals) gains and loses the key while records cover both
  const plain: Bag = heap({ other: 3 });
  const inst: Links = heap(new L8()); inst.type = 2;
  const r10: unknown[] = [];
  for (let i = 0; i < 24; i++) {
    if (i === 6) (Object.prototype as unknown as Bag).k = 70;
    if (i === 10) delete (Object.prototype as unknown as Bag).k;
    if (i === 16) plain.k = 1;
    r10.push(plain.k, (inst as unknown as Bag).k);
  }
  console.log("objproto", r10.join(","));
}
main();
