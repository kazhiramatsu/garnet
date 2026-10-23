// tsc-ts style, with the const enums tsc keeps in its nodes: `kind` and `flags` are enum-typed class
// fields (int32 values), read in switches and flag tests, written with enum constants.
const enum Kind { Identifier = 80, Literal = 9, Binary = 226, Block = 241, Call = 213 }
const enum Flags { None = 0, Const = 1 << 1, Let = 1 << 0, Async = 1 << 10, Generator = 1 << 9, Ambient = 1 << 25 }
class Nd {
  kind: Kind; flags: Flags; pos: number; end: number; parent: Nd | undefined;
  constructor(kind: Kind, pos: number, end: number) { this.kind = kind; this.flags = Flags.None; this.pos = pos; this.end = end; this.parent = undefined; }
  hasFlag(f: Flags): boolean { return (this.flags & f) !== 0; }
}
class Identifier extends Nd { text: string; constructor(pos: number, end: number, text: string) { super(Kind.Identifier, pos, end); this.text = text; } }
class Literal extends Nd { value: number; constructor(pos: number, end: number, value: number) { super(Kind.Literal, pos, end); this.value = value; } }
class Binary extends Nd { left: Nd; right: Nd; constructor(pos: number, end: number, left: Nd, right: Nd) { super(Kind.Binary, pos, end); this.left = left; this.right = right; } }
function weight(n: Nd): number {
  switch (n.kind) {
    case Kind.Identifier: return (n as Identifier).text.length;
    case Kind.Literal: return (n as Literal).value & 7;
    case Kind.Binary: { const b = n as Binary; return (b.hasFlag(Flags.Async) ? 2 : 1) + (b.left.kind === Kind.Literal ? 3 : 0); }
    default: return 0;
  }
}
function main(): void {
  const nodes: Nd[] = [];
  for (let i = 0; i < 1024; i++) {
    const k = i % 3; let n: Nd;
    if (k === 0) n = new Identifier(i, i + 5, "name" + (i & 15));
    else if (k === 1) n = new Literal(i, i + 2, i * 7);
    else n = new Binary(i, i + 9, nodes[i - 2], nodes[i - 1]);
    if (i > 0) n.parent = nodes[i - 1];
    if ((i & 3) === 0) n.flags |= Flags.Async;
    if ((i & 15) === 0) n.flags |= Flags.Ambient;
    nodes.push(n);
  }
  let sum = 0;
  for (let r = 0; r < 40000; r++) for (let i = 0; i < 1024; i++) { const n = nodes[i];
    sum += weight(n);
    const p = n.parent; if (p !== undefined && (p.flags & Flags.Ambient) !== 0) sum += p.kind;
    if (n.kind === Kind.Binary && (n.flags & (Flags.Async | Flags.Generator)) === Flags.Async) n.flags |= Flags.Const; }
  console.log(sum);
}
main();
