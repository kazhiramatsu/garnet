// Constructor-style functions that capture module state: `this` is the
// parameter after the captured cells, and the leading `this.x = ...` stores
// adopt the layout only on a fresh instance (generic stores otherwise).
interface Nd { pos: number; end: number; kind: number; id: number; flags: number; parent: Nd | undefined; name?: string; }
let nextId = 0;          // captured by the constructors below (a cell)
let created = 0;
const log: number[] = [];
function NodeF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind; this.id = ++nextId; this.flags = 0; this.parent = undefined;
  created++;
}
function TokenF(this: Nd, kind: number, pos: number): void {
  this.pos = pos; this.end = pos + 1; this.kind = kind; this.id = 0; this.flags = 1; this.parent = undefined;
  created++;
}
// A constructor whose inner closure captures `this` keeps the generic stores.
interface Counter { n: number; step: number; bump: () => number; }
function CounterF(this: Counter, step: number): void {
  this.n = 0; this.step = step;
  this.bump = () => { this.n += this.step; return this.n; };
}
// A constructor with a call between the stores (user code may observe `this`).
function LoggedF(this: Nd, kind: number): void {
  this.kind = kind; created++; log.push(created); this.pos = -1; this.end = -1; this.id = 0; this.flags = 0; this.parent = undefined;
}
// A constructor that stores a key twice: the layout ends at the repeat.
function TwiceF(this: Nd, kind: number): void {
  this.kind = kind; this.pos = 1; this.kind = kind * 2; this.end = 2; this.id = 0; this.flags = 0; this.parent = undefined;
}
type NdCtor = new (kind: number, pos: number, end: number) => Nd;
type TokCtor = new (kind: number, pos: number) => Nd;
type NodeCall = (this: Nd, k: number, p: number, e: number) => void;
const allocator = { getNodeConstructor: () => NodeF as unknown as NdCtor, getTokenConstructor: () => TokenF as unknown as TokCtor };
function main(): void {
  const NodeCtor = allocator.getNodeConstructor();
  const TokenCtor = allocator.getTokenConstructor();
  const a = new NodeCtor(5, 10, 20);
  const b = new TokenCtor(3, 7);
  console.log(Object.keys(a).join(","), a.pos, a.end, a.kind, a.id, a.flags, a.parent);
  console.log(Object.keys(b).join(","), b.pos, b.end, b.kind, b.id, b.flags, b.parent);
  // later additions and writes keep working
  b.parent = a; a.name = "root"; b.flags |= 8;
  console.log(Object.keys(a).join(","), a.name, b.parent === a, b.flags);
  // `.call` on a non-empty receiver: generic stores, no layout adoption
  const existing = { extra: 1 } as unknown as Nd;
  (NodeF as unknown as NodeCall).call(existing, 1, 2, 3);
  console.log(Object.keys(existing).join(","), existing.kind, (existing as unknown as { extra: number }).extra, existing.id);
  // `.call` on an empty receiver adopts the layout; the keys come in store order
  const empty = {} as Nd;
  (NodeF as unknown as NodeCall).call(empty, 9, 8, 7);
  console.log(Object.keys(empty).join(","), empty.kind, empty.id);
  // inner closure capturing `this`
  const CounterCtor = CounterF as unknown as new (step: number) => Counter;
  const c = new CounterCtor(3);
  console.log(Object.keys(c).join(","), c.bump(), c.bump(), c.n);
  // a call between the stores, and a repeated key
  const LoggedCtor = LoggedF as unknown as new (kind: number) => Nd;
  const l = new LoggedCtor(4);
  console.log(Object.keys(l).join(","), l.kind, log.join(","));
  const TwiceCtor = TwiceF as unknown as new (kind: number) => Nd;
  const t = new TwiceCtor(4);
  console.log(Object.keys(t).join(","), t.kind, t.pos, t.end);
  // many instances: shapes stay consistent and the GC sees every field
  const nodes: Nd[] = [];
  for (let i = 0; i < 20000; i++) {
    const n = (i & 1) ? new NodeCtor(i & 255, i, i + 3) : new TokenCtor(i & 127, i);
    n.parent = nodes.length ? nodes[i >> 1] : undefined;
    if ((i & 7) === 0) n.name = "n" + i;
    nodes.push(n);
  }
  let sum = 0, ids = 0, named = 0;
  for (const n of nodes) {
    sum += n.kind + n.end - n.pos + (n.flags & 1);
    if (n.id) ids++;
    if (n.name !== undefined) named++;
    if (n.parent !== undefined && n.parent.kind < 0) sum = -1;
  }
  console.log(sum, ids, named, created, nextId, nodes[19999].parent === nodes[9999], nodes[8].name);
  // JSON and enumeration order follow the store order
  console.log(JSON.stringify(nodes[2]), JSON.stringify(nodes[3]).length);
}
main();
