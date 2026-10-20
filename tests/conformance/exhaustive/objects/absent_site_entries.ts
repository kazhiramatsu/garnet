// Absent-property entries (docs/negative_cache_design.md): a read a site
// found absent before is answered from its entry while nothing on the chain
// changed. Each case reads at one site in a loop and changes the chain
// between iterations, so the same site's entry must notice every change
// (small readers are inlined: every call site has its own cache).
interface Bag { k?: number; other?: number; tag?: string; }
const pinned: object[] = [];   // prototypes stay heap objects
function heap<T extends object>(o: T): T { pinned.push(o); return o; }
let junk: number[][] = [];
function churn(n: number): void {
  for (let i = 0; i < n; i++) junk.push([i, i + 1, i + 2]);
  if (junk.length > 4096) junk = [];
}
// one read site shared by every caller (a call through a value is not inlined)
function readK(o: Bag): number | undefined { return o.k; }
const reader: ((o: Bag) => number | undefined)[] = [readK];
function recordAbsent(i: number): void {
  const p0: Bag = { other: i };
  reader[0](Object.create(p0) as Bag);
}
function main(): void {
  // 1. a prototype gains, loses and regains the key, then is frozen
  const proto: Bag = heap({ other: 1 });
  const a = heap(Object.create(proto) as Bag);
  const r1: unknown[] = [];
  for (let i = 0; i < 12; i++) {
    if (i === 3) proto.k = 5;
    if (i === 5) delete proto.k;
    if (i === 7) proto.k = 6;
    if (i === 9) Object.freeze(proto);
    r1.push(a.k);
  }
  console.log("proto", r1.join(","));

  // 2. an object sharing the prototype's shape changes (an invalidation
  //    only), then the prototype itself
  const p2: Bag = heap({ other: 3 });
  const twin: Bag = heap({ other: 4 });
  const b = heap(Object.create(p2) as Bag);
  const r2: unknown[] = [];
  for (let i = 0; i < 9; i++) {
    if (i === 3) twin.k = 9;
    if (i === 6) p2.k = 10;
    r2.push(b.k);
  }
  console.log("twin", r2.join(","), twin.k);

  // 3. the receiver is relinked to a prototype that has the key, and back;
  //    a prototype's own prototype is relinked
  const p3a: Bag = heap({ other: 5 });
  const p3b: Bag = heap({ other: 6, k: 55 });
  const c = heap(Object.create(p3a) as Bag);
  const mid: Bag = heap({ other: 7 });
  const top: Bag = heap({ other: 8, k: 77 });
  const d = heap(Object.create(mid) as Bag);
  const r3: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    if (i === 2) Object.setPrototypeOf(c, p3b);
    if (i === 4) Object.setPrototypeOf(c, p3a);
    if (i === 6) Object.setPrototypeOf(mid, top);
    r3.push(c.k, d.k);
  }
  console.log("relink", r3.join(","));

  // 4. an accessor on the prototype, then a non-writable data property,
  //    then a deletion
  const p4: Bag = heap({ other: 9 });
  const e = heap(Object.create(p4) as Bag);
  const r4: unknown[] = [];
  for (let i = 0; i < 9; i++) {
    if (i === 2) Object.defineProperty(p4, "k", { get() { return 66; }, configurable: true });
    if (i === 4) Object.defineProperty(p4, "k", { value: 67, writable: false, configurable: true });
    if (i === 6) delete p4.k;
    r4.push(e.k);
  }
  console.log("accessor", r4.join(","));

  // 5. same receiver shape, a different direct prototype per receiver: the
  //    prototypes die young and their handles are reused after collections
  let sum = 0, undef = 0;
  for (let i = 0; i < 20000; i++) {
    const p: Bag = (i % 3 === 0) ? { other: i, k: i } : { other: i };
    pinned.push(p);
    const o = Object.create(p) as Bag;
    const v = o.k;
    if (v === undefined) undef++; else sum += v;
    if ((i & 15) === 0) { churn(64); pinned.length = 0; }
  }
  console.log("handles", sum, undef);

  // 6. two receiver shapes alternating at one site, then the key on their
  //    prototype; a four-deep chain; array receivers
  const p6: Bag = heap({ other: 10 });
  const s1 = heap(Object.create(p6) as Bag);
  const s2 = heap(Object.create(p6) as Bag); s2.other = 11;
  let alt = 0;
  for (let i = 0; i < 1000; i++) {
    if (i === 600) p6.k = 1;
    const v = ((i & 1) ? s1 : s2).k;
    alt += v === undefined ? 1 : 1000;
  }
  const l1: Bag = heap({ other: 12 });
  const l2 = heap(Object.create(l1) as Bag); l2.other = 13;
  const l3 = heap(Object.create(l2) as Bag); l3.other = 14;
  const deep = heap(Object.create(l3) as Bag);
  const arr: any = heap([1, 2, 3]);
  const r6: unknown[] = [];
  for (let i = 0; i < 6; i++) {
    if (i === 2) { l1.k = 100; (Array.prototype as any).k = 300; }
    if (i === 4) { delete l1.k; delete (Array.prototype as any).k; }
    r6.push(deep.k, arr.k);
  }
  console.log("shapes", alt, r6.join(","));

  // 7. prototypes promoted by collections between the reads
  const keep: Bag[] = [];
  for (let i = 0; i < 64; i++) keep.push({ other: i });
  let late = 0;
  for (let round = 0; round < 6; round++) {
    if (round === 3) keep[17].k = 1000;
    for (let i = 0; i < 64; i++) {
      const o = Object.create(keep[i]) as Bag;
      const v = o.k;
      late += v === undefined ? 1 : v;
    }
    churn(4000);
  }
  console.log("promoted", late);

  // 8. the site records a young prototype that dies; the next prototype,
  //    which has the key, can take its handle after a collection (under
  //    TSAOT_GC_YOUNG_THRESHOLD=1 every allocation collects first)
  let stale = 0, found = 0;
  for (let i = 0; i < 3000; i++) {
    recordAbsent(i);
    const p1: Bag = { other: i, k: i };
    const v = reader[0](Object.create(p1) as Bag);
    if (v === undefined) stale++; else found += v;
  }
  console.log("reuse", stale, found);

  // 9. Object.prototype (two links up) gains and loses the key (last: the
  //    deletion leaves it a dictionary)
  const plain: Bag = heap({ other: 2 });
  const r8: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    if (i === 3) (Object.prototype as Bag).tag = "op";
    if (i === 5) delete (Object.prototype as Bag).tag;
    r8.push(plain.tag);
  }
  console.log("objproto", r8.join(","), junk.length >= 0);
}
main();
