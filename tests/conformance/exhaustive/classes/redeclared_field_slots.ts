// A subclass whose constructor assigns an inherited field (`this.flags =
// flags`) declares it again; the struct slot stays the ancestor's. With the
// strict type profile (TSAOT_CONF_STRICT=1, a project's strict tsconfig) the
// subclass's numeric field type made typed accesses treat the boxed slot as a
// double: a write converted the double into the slot's bits, and a generic
// read (through `any`, a base-typed `|=`) saw garbage (tsc-ts's parser kept
// every declaration list's `const` flag this way and printed `var`).
const enum NF { None = 0, Let = 1, Const = 2, Ambient = 1 << 23 }
abstract class Node {
  readonly kind: number;
  flags: NF;
  constructor(kind: number) { this.kind = kind; this.flags = NF.None; }
  abstract name(): string;
}
class List extends Node {
  items: string[];
  constructor(items: string[], flags: NF) { super(262); this.items = items; this.flags = flags; }
  name(): string { return "List"; }
}
class Other extends Node { constructor() { super(1); } name(): string { return "Other"; } }
class Parser {
  contextFlags: NF = NF.Ambient;
  finishNode(node: Node): Node { node.flags |= this.contextFlags; return node; }
  attach(node: Node): void { (node as Node & { flowNode?: number }).flowNode = 7; }
  parseList(flags: NF): List {
    const result = new List(["x"], flags);
    const generic: any = result;
    console.log("generic read", generic.flags);
    this.finishNode(result);
    console.log("after finish", result.flags, (result.flags & NF.Const) !== 0, generic.flags);
    return result;
  }
}
const p = new Parser();
p.attach(new Other());
const l = p.parseList(NF.Const);
console.log(l.flags, l.name(), JSON.stringify({ ...l }));
export {};
