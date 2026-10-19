// tsc objectAllocator pattern: function constructors reached through a factory
// object, `new` on a function value, ten `this.x = ...` adds per instance.
interface Nd { pos: number; end: number; kind: number; id: number; flags: number; modifierFlagsCache: number; transformFlags: number; parent: Nd | undefined; original: Nd | undefined; emitNode: unknown; }
function NodeF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind; this.id = 0; this.flags = 0;
  this.modifierFlagsCache = 0; this.transformFlags = 0; this.parent = undefined!; this.original = undefined; this.emitNode = undefined;
}
function TokenF(this: Nd, kind: number, pos: number, end: number): void {
  this.pos = pos; this.end = end; this.kind = kind; this.id = 0; this.flags = 0;
  this.modifierFlagsCache = 0; this.transformFlags = 0; this.parent = undefined!; this.original = undefined; this.emitNode = undefined;
}
type NdCtor = new (kind: number, pos: number, end: number) => Nd;
const allocator = { getNodeConstructor: () => NodeF as any as NdCtor, getTokenConstructor: () => TokenF as any as NdCtor };
let nextId = 0;
function main(): void {
  const NodeCtor = allocator.getNodeConstructor(); const TokenCtor = allocator.getTokenConstructor();
  let sum = 0;
  for (let r = 0; r < 3000; r++) {
    const nodes: Nd[] = [];
    for (let i = 0; i < 2000; i++) {
      const n = (i & 1) ? new NodeCtor(i & 255, i, i + 3) : new TokenCtor(i & 127, i, i + 1);
      n.parent = nodes[i >> 1]; nodes.push(n);
    }
    for (const n of nodes) { if (!n.id) n.id = ++nextId; sum += n.kind + n.end - n.pos + (n.flags & 1); }
  }
  console.log(sum, nextId);
}
main();
