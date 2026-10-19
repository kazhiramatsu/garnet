// Reads of properties the receiver does not have, repeated at one site while
// the receiver, its prototype, a grandparent prototype, the chain links and
// the class registry change underneath: every change must be observed.
interface Links { _brand?: any; type?: number; target?: Links; name?: string; extra?: number; viaProto?: number; deep?: string; acc?: number; }
const Links = class implements Links { declare _brand: any; };
class Base {}
class Mid extends Base {}
class Leaf extends Mid {}
interface Base { b?: number; shared?: string; }
interface Leaf { l?: number; }
function readType(l: Links): number | undefined { return l.type; }
function readVia(l: Links): number | undefined { return l.viaProto; }
function readDeep(l: Links): string | undefined { return l.deep; }
function readAcc(l: Links): number | undefined { return l.acc; }
function readShared(o: Base): string | undefined { return o.shared; }
function readL(o: Leaf): number | undefined { return o.l; }
function main(): void {
  const a: Links = new Links(); const b: Links = new Links(); const c: Links = new Links();
  const out: unknown[] = [];
  // 1. absent on the receiver, then added to the receiver
  for (let i = 0; i < 5; i++) out.push(readType(a));
  a.type = 7; out.push(readType(a), readType(b));
  b.name = "n"; out.push(readType(b)); b.type = 8; out.push(readType(b));
  console.log(out.join(","));
  // 2. absent, then added to the prototype (data), then to the grandparent
  const r: unknown[] = [];
  for (let i = 0; i < 5; i++) r.push(readVia(a), readVia(c));
  (Links.prototype as Links).viaProto = 42; r.push(readVia(a), readVia(c));
  for (let i = 0; i < 3; i++) r.push(readDeep(c));
  (Object.prototype as unknown as Links).deep = "polluted"; r.push(readDeep(c), readDeep(a));
  delete (Object.prototype as unknown as Links).deep; r.push(readDeep(c));
  delete (Links.prototype as Links).viaProto; r.push(readVia(a));
  console.log(r.join(","));
  // 3. accessor defined on the prototype after the absent reads
  const s: unknown[] = [];
  for (let i = 0; i < 4; i++) s.push(readAcc(a));
  Object.defineProperty(Links.prototype, "acc", { get() { return 99; }, configurable: true });
  s.push(readAcc(a), readAcc(b));
  Object.defineProperty(Links.prototype, "acc", { value: 5, writable: true, configurable: true });
  s.push(readAcc(a));
  delete (Links.prototype as Links).acc; s.push(readAcc(a));
  console.log(s.join(","));
  // 4. the receiver's prototype is relinked; a prototype's prototype is relinked
  const t: unknown[] = [];
  const other = { viaProto: 1, type: 2 } as Links;
  for (let i = 0; i < 3; i++) t.push(readVia(c));
  Object.setPrototypeOf(c, other); t.push(readVia(c), readType(c));
  Object.setPrototypeOf(c, Links.prototype); t.push(readVia(c));
  const mid = { deep: "mid" } as Links;
  Object.setPrototypeOf(mid, Object.prototype);
  const leaf = Object.create(Links.prototype) as Links;
  for (let i = 0; i < 3; i++) t.push(readDeep(leaf));
  Object.setPrototypeOf(Links.prototype, mid); t.push(readDeep(leaf), readDeep(a));
  Object.setPrototypeOf(Links.prototype, Object.prototype); t.push(readDeep(leaf));
  console.log(t.join(","));
  // 5. class hierarchy three deep: keys added at every level, in both orders
  const u: unknown[] = [];
  const lf = new Leaf(), bs = new Base(), md = new Mid();
  for (let i = 0; i < 3; i++) u.push(readShared(lf), readShared(bs), readL(lf));
  (Base.prototype as Base).shared = "base"; u.push(readShared(lf), readShared(md), readShared(bs));
  (Mid.prototype as Base).shared = "mid"; u.push(readShared(lf), readShared(md), readShared(bs));
  lf.l = 3; u.push(readL(lf), readL(new Leaf()));
  (Leaf.prototype as Leaf).l = 4; u.push(readL(new Leaf()), readL(lf));
  console.log(u.join(","));
  // 6. receivers of different prototypes and shapes at one site; a dictionary-mode receiver
  const v: unknown[] = [];
  const plain = { extra: 1 } as Links; const dict = { type: 1, name: "d", extra: 2 } as Links;
  delete dict.type;
  const mixed: Links[] = [a, b, plain, dict, new Links(), Object.create(null) as Links];
  for (let round = 0; round < 3; round++) for (const m of mixed) v.push(readType(m));
  (plain as Links).type = 11; dict.type = 12; v.push(readType(plain), readType(dict));
  console.log(v.join(","));
  // 7. frozen prototype, then a key added to the receiver anyway
  const w: unknown[] = [];
  const P = { } as Links; const q = Object.create(P) as Links;
  for (let i = 0; i < 3; i++) w.push(readType(q));
  Object.freeze(P); w.push(readType(q)); q.type = 13; w.push(readType(q), "type" in q, Object.prototype.hasOwnProperty.call(q, "name"));
  console.log(w.join(","));
  // 8. many receivers and collections between the reads and the writes
  const many: Links[] = [];
  for (let i = 0; i < 30000; i++) { const l: Links = new Links(); l.name = "m" + (i & 7); many.push(l); }
  let absent = 0, present = 0;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < many.length; i++) { if (readType(many[i]) === undefined) absent++; else present++; }
    if (round < 2) for (let i = round; i < many.length; i += 3) many[i].type = i;
  }
  (Links.prototype as Links).type = -1;
  let inherited = 0; for (const l of many) if (readType(l) === -1) inherited++;
  console.log(absent, present, inherited);
}
main();
