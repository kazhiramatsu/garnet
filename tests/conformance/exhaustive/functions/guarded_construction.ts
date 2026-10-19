// Guarded direct construction: a `new` through a function value whose target
// the exporter predicts from the site's type (constructor functions with a
// `this` parameter) tests the value's code and calls the body directly on a
// hit. Every observable result must match V8: the instance's prototype and
// fields, slack-sized instances growing later, object and primitive returns
// from the constructor, a variable rebound to another constructor (a miss on
// the first candidate, a hit on another), a class value and an arrow in the
// same variable (the generic path, including the TypeError), prototypes
// replaced after the first construction, `instanceof`, and argument counts.
interface Nd { pos: number; end: number; kind: number; id: number; flags: number; parent: Nd | undefined; extra?: string; }
function NodeF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind; this.id = 0; this.flags = 0; this.parent = undefined;
}
function TokenF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind + 1000; this.id = 1; this.flags = 2; this.parent = undefined;
}
function IdentifierF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind + 2000; this.id = 2; this.flags = 4; this.parent = undefined; this.extra = "id";
}
function Returning(this: Nd, kind: number, pos: number, end: number): any {
  this.pos = pos; this.end = end; this.kind = kind; this.id = 3; this.flags = 3; this.parent = undefined;
  return kind > 100 ? { pos: -1, end: -1, kind: -kind, id: 9, flags: 9, parent: undefined } : 7;
}
interface Links { flags: number; resolved?: Nd; }
function LinksF(this: Links): void { this.flags = 0; }
type NdCtor = new (kind: number, pos: number, end: number) => Nd;
class NodeClass implements Nd {
  pos: number; end: number; kind: number; id = 5; flags = 6; parent: Nd | undefined = undefined;
  constructor(kind: number, pos: number, end: number) { this.pos = pos; this.end = end; this.kind = kind; }
}
let NodeCtor: NdCtor = NodeF as unknown as NdCtor;
let TokenCtor: NdCtor = TokenF as unknown as NdCtor;
let AnyCtor: any = IdentifierF;
function describe(n: Nd): string { return [n.kind, n.pos, n.end, n.id, n.flags, n.parent, n.extra].join("/"); }
function makeMany(ctor: NdCtor, count: number): Nd[] {
  const out: Nd[] = [];
  for (let i = 0; i < count; i++) out.push(new ctor(i, i * 2, i * 3));
  return out;
}
function main(): void {
  const a = new NodeCtor(1, 2, 3);
  const b = new TokenCtor(1, 2, 3);
  const c: Nd = new AnyCtor(1, 2, 3);
  console.log(describe(a), describe(b), describe(c));
  console.log(Object.getPrototypeOf(a) === NodeF.prototype, Object.getPrototypeOf(b) === TokenF.prototype, Object.getPrototypeOf(c) === IdentifierF.prototype, a instanceof (NodeF as any), b instanceof (NodeF as any));
  // the same variable rebound: the first candidate misses, another hits
  NodeCtor = TokenF as unknown as NdCtor;
  const d = new NodeCtor(5, 6, 7);
  NodeCtor = IdentifierF as unknown as NdCtor;
  const e = new NodeCtor(5, 6, 7);
  console.log(describe(d), describe(e), Object.getPrototypeOf(e) === IdentifierF.prototype);
  // a class value and a non-constructor in the variable: the generic path
  NodeCtor = NodeClass as unknown as NdCtor;
  const f = new NodeCtor(8, 9, 10);
  console.log(describe(f), f instanceof NodeClass, Object.getPrototypeOf(f) === NodeClass.prototype);
  NodeCtor = ((kind: number, pos: number, end: number) => ({ kind, pos, end })) as unknown as NdCtor;
  try { new NodeCtor(1, 2, 3); console.log("no throw"); } catch (err: any) { console.log("throws", err instanceof TypeError); }
  // constructors returning an object or a primitive
  const RetCtor = Returning as unknown as NdCtor;
  const g = new RetCtor(200, 1, 2);
  const h = new RetCtor(3, 1, 2);
  console.log(describe(g), describe(h), Object.getPrototypeOf(g) === Object.prototype, Object.getPrototypeOf(h) === Returning.prototype);
  // slack: instances gain fields after construction, later instances still carry them
  const links: Links[] = [];
  for (let i = 0; i < 50; i++) { const l = new (LinksF as any)() as Links; if (i % 2) l.resolved = a; links.push(l); }
  console.log(links[1].resolved === a, links[2].resolved, links[49].flags, Object.keys(links[3]).join(","), Object.keys(links[4]).join(","));
  // prototype replaced after the first construction
  const before = new TokenCtor(1, 1, 1);
  (TokenF as any).prototype = { tag: "replaced" };
  const after = new TokenCtor(1, 1, 1);
  console.log((before as any).tag, (after as any).tag, Object.getPrototypeOf(after) === (TokenF as any).prototype);
  // many constructions through a parameter holding different constructors
  const n1 = makeMany(NodeF as unknown as NdCtor, 3000), n2 = makeMany(TokenF as unknown as NdCtor, 3000), n3 = makeMany(IdentifierF as unknown as NdCtor, 3000);
  let sum = 0;
  for (let i = 0; i < 3000; i++) sum += n1[i].kind + n2[i].kind + n3[i].kind + n1[i].pos + n3[i].flags;
  console.log(sum, n1[2999].end, n2[10].id, n3[0].extra);
  // argument counts: fewer and more than the parameters
  // (a numeric parameter or field that holds undefined is outside this fixture:
  // the typed read of such a value is a known deviation recorded in the TODO)
  const Few = NodeF as unknown as new (k: number) => Nd;
  const More = NodeF as unknown as new (k: number, p: number, e: number, x: number) => Nd;
  const few = new Few(4), more = new More(4, 5, 6, 7);
  console.log(few.kind, few.id, Object.keys(few).length, describe(more), Object.keys(more).length);
}
main();
