// Static slots (docs/static_slots_design.md): a property read or write whose
// receiver's static type is produced by constructor functions with a `this`
// parameter carries the slot the constructors' prefix stores give the key; the
// emitted probe validates the slot against the receiver's shape and takes the
// generic path otherwise. Every observable result must match V8: constructed
// objects (one slot, two slots after a gap, no hint for a key one constructor
// lacks), literals with the keys in the same and in another order, accessors on
// a hinted key, frozen objects, keys found only on the prototype, class
// instances, dictionaries, undefined/null receivers, `any` receivers, long
// layouts beyond the slot limit and the in-object capacity, and key order.
interface Nd { pos: number; end: number; kind: number; id: number; flags: number; cache?: number; tf: number; parent: Nd | undefined; extra?: string; }
function NodeF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind; this.id = 0; this.flags = 0; this.cache = -1; this.tf = 1; this.parent = undefined;
}
function TokenF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind + 1000; this.id = 1; this.flags = 2; this.cache = -1; this.tf = 2; this.parent = undefined;
}
function IdentF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind + 2000; this.id = 2; this.flags = 4; this.tf = 3; this.parent = undefined; this.extra = "id";
}
interface Sym { flags: number; name: string; decl: Nd | undefined; count: number; }
function SymF(this: Sym, flags: number, name: string): void { this.flags = flags | 8; this.name = name; this.decl = undefined; this.count = 0; }
interface Wide { k0: number; k1: number; k2: number; k3: number; k4: number; k5: number; k6: number; k7: number; k8: number; k9: number; k10: number; k11: number; k12: number; k13: number; k14: number; k15: number; k16: number; k17: number; k18: number; k19: number; }
function WideF(this: Wide, base: number): void {
  this.k0 = base; this.k1 = base + 1; this.k2 = base + 2; this.k3 = base + 3; this.k4 = base + 4; this.k5 = base + 5; this.k6 = base + 6; this.k7 = base + 7; this.k8 = base + 8; this.k9 = base + 9;
  this.k10 = base + 10; this.k11 = base + 11; this.k12 = base + 12; this.k13 = base + 13; this.k14 = base + 14; this.k15 = base + 15; this.k16 = base + 16; this.k17 = base + 17; this.k18 = base + 18; this.k19 = base + 19;
}
type NdCtor = new (kind: number, pos: number, end: number) => Nd;
class NodeClass implements Nd {
  pos: number; end: number; kind: number; id = 5; flags = 6; tf = 7; parent: Nd | undefined = undefined;
  constructor(kind: number, pos: number, end: number) { this.pos = pos; this.end = end; this.kind = kind; }
}
const NodeCtor = NodeF as unknown as NdCtor, TokenCtor = TokenF as unknown as NdCtor, IdentCtor = IdentF as unknown as NdCtor;
const SymCtor = SymF as unknown as new (flags: number, name: string) => Sym;
const WideCtor = WideF as unknown as new (base: number) => Wide;
function describe(n: Nd): string { return [n.kind, n.pos, n.end, n.id, n.flags, n.cache, n.tf, n.parent === undefined ? "u" : n.parent.kind, n.extra].join("/"); }
function sumKinds(ns: Nd[]): number { let s = 0; for (const n of ns) s += n.kind + n.flags + n.tf; return s; }
function setParents(ns: Nd[], p: Nd): void { for (const n of ns) { n.parent = p; n.flags |= 16; n.tf = n.tf * 2; } }
function readAny(o: any): string { return String(o.kind) + "/" + String(o.flags); }
function readUnion(v: Nd | Sym): number { return v.flags; }
function main(): void {
  const a = new NodeCtor(1, 2, 3), b = new TokenCtor(1, 2, 3), c = new IdentCtor(1, 2, 3);
  console.log(describe(a), describe(b), describe(c));
  // writes through the hinted sites, on both layouts (tf sits at slot 6 and 5)
  setParents([a, b, c], a);
  console.log(describe(a), describe(b), describe(c), sumKinds([a, b, c]));
  // literals typed as the interface: the same key order hits, another order misses
  const sameOrder: Nd = { pos: 10, end: 11, kind: 12, id: 13, flags: 14, cache: 15, tf: 16, parent: undefined };
  const otherOrder: Nd = { kind: 22, flags: 24, pos: 20, end: 21, id: 23, tf: 26, parent: undefined, cache: 25 };
  const noCache: Nd = { pos: 30, end: 31, kind: 32, id: 33, flags: 34, tf: 36, parent: undefined };
  console.log(describe(sameOrder), describe(otherOrder), describe(noCache), sumKinds([sameOrder, otherOrder, noCache]));
  setParents([sameOrder, otherOrder, noCache], b);
  console.log(describe(sameOrder), describe(otherOrder), describe(noCache), Object.keys(otherOrder).join(","));
  // accessors on a hinted key: the getter and setter must run
  let setLog = "";
  const acc = { pos: 40, end: 41, get kind() { return 42; }, id: 43, set flags(v: number) { setLog += "set" + v; }, get flags() { return 44; }, tf: 46, parent: undefined } as unknown as Nd;
  acc.flags = 45;
  try { acc.kind = 99; console.log("no throw"); } catch (err: any) { console.log("getter-only", err instanceof TypeError); }
  console.log(describe(acc), setLog, Object.keys(acc).join(","));
  // frozen receiver: the write throws (strict mode), the read works
  const frozen = Object.freeze(new NodeCtor(7, 8, 9)) as Nd;
  try { frozen.flags = 1; console.log("no throw"); } catch (err: any) { console.log("frozen", err instanceof TypeError, frozen.flags); }
  // the key only on the prototype: the probe misses, the generic read finds it
  const proto = new NodeCtor(50, 51, 52);
  const child = Object.create(proto) as Nd;
  child.flags = 53;
  console.log(child.kind, child.flags, child.pos, Object.keys(child).join(","), proto.flags);
  // a class instance typed as the interface
  const cls: Nd = new NodeClass(60, 61, 62);
  console.log(describe(cls), sumKinds([cls]));
  setParents([cls], a);
  console.log(describe(cls));
  // a dictionary (after delete): generic path
  const dict = new NodeCtor(70, 71, 72);
  delete (dict as any).cache;
  dict.flags = 73;
  console.log(describe(dict), Object.keys(dict).join(","));
  // undefined / null receivers through the typed sites: TypeError
  for (const r of [undefined, null]) {
    try { const n = r as unknown as Nd; console.log(n.kind); } catch (err: any) { console.log("throws", err instanceof TypeError); }
    try { const n = r as unknown as Nd; n.flags = 1; console.log("no throw"); } catch (err: any) { console.log("throws", err instanceof TypeError); }
  }
  // any receivers and a union of two layouts (flags at slot 4 and slot 0)
  const s1 = new SymCtor(1, "s1"), s2 = new SymCtor(2, "s2");
  console.log(readAny(a), readAny(s1), readAny({ kind: "k", flags: "f" }), readUnion(a), readUnion(s1), readUnion(c), s1.name, s2.count, s2.decl);
  s1.decl = a; s1.count = 5; s2.name = "renamed";
  console.log(s1.decl === a, s1.count, s2.name, Object.keys(s1).join(","));
  // a long layout: slots at and beyond the limit, and beyond the first instance's in-object capacity
  const w1 = new WideCtor(100), w2 = new WideCtor(200);
  console.log(w1.k0, w1.k11, w1.k12, w1.k15, w1.k16, w1.k19, w2.k13 + w2.k17);
  w1.k12 = -1; w1.k16 = -2; w2.k0 = -3; w2.k19 = -4;
  console.log(w1.k12, w1.k16, w2.k0, w2.k19, Object.keys(w1).length);
  // many constructions and reads through a parameter
  const many: Nd[] = [];
  for (let i = 0; i < 20000; i++) many.push(i % 3 === 0 ? new NodeCtor(i, i, i) : i % 3 === 1 ? new TokenCtor(i, i, i) : new IdentCtor(i, i, i));
  setParents(many, a);
  let total = 0;
  for (const n of many) total += n.kind + n.id + n.tf + (n.parent === a ? 1 : 0);
  console.log(total, sumKinds(many), many[19999].extra, many[3].cache);
}
main();
