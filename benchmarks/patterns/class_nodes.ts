// tsc-ts style (Nd, not Nd: the DOM lib has one): classes with declared fields, a kind-discriminated hierarchy,
// small methods, a downcast, a field store and a Map lookup per node.
class Nd { kind: number; flags: number; pos: number; end: number; parent: Nd | undefined; id: number;
  constructor(kind: number, pos: number, end: number, id: number) { this.kind = kind; this.flags = 0; this.pos = pos; this.end = end; this.parent = undefined; this.id = id; }
  get width(): number { return this.end - this.pos; }
  hasFlag(f: number): boolean { return (this.flags & f) !== 0; } }
class Identifier extends Nd { text: string; constructor(pos: number, end: number, id: number, text: string) { super(80, pos, end, id); this.text = text; } }
class Literal extends Nd { value: number; constructor(pos: number, end: number, id: number, value: number) { super(9, pos, end, id); this.value = value; } }
class Binary extends Nd { left: Nd; right: Nd; constructor(pos: number, end: number, id: number, left: Nd, right: Nd) { super(226, pos, end, id); this.left = left; this.right = right; } }
function isIdentifier(n: Nd): n is Identifier { return n.kind === 80; }
function isLiteral(n: Nd): n is Literal { return n.kind === 9; }
function score(n: Nd, links: Map<number, number>): number {
  if (isIdentifier(n)) return n.text.length + (links.get(n.id) ?? 0);
  if (isLiteral(n)) return n.value & 7;
  const b = n as Binary; return (b.hasFlag(16) ? 2 : 1) + b.width;
}
function main(): void {
  const nodes: Nd[] = []; const links = new Map<number, number>();
  for (let i = 0; i < 1024; i++) {
    const k = i % 3; let n: Nd;
    if (k === 0) n = new Identifier(i, i + 5, i, "name" + (i & 15));
    else if (k === 1) n = new Literal(i, i + 2, i, i * 7);
    else n = new Binary(i, i + 9, i, nodes[i - 2], nodes[i - 1]);
    if (i > 0) n.parent = nodes[i - 1];
    if ((i & 3) === 0) n.flags |= 16;
    if ((i & 7) === 0) links.set(i, i & 31);
    nodes.push(n);
  }
  let sum = 0;
  for (let r = 0; r < 40000; r++) for (let i = 0; i < 1024; i++) { const n = nodes[i];
    sum += score(n, links);
    const p = n.parent; if (p !== undefined && p.hasFlag(16)) sum += p.kind;
    if (n.kind === 226) { const b = n as Binary; if (b.left.pos < b.right.pos) b.flags |= 32; } }
  console.log(sum);
}
main();
