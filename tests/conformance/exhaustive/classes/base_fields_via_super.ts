// A base class constructed only through `super`: its numeric fields take their
// representation from the subclasses' instantiations (exporter,
// recordInstantiationFieldTypes). Reads and writes through base-typed references,
// compound assignments, a field assigned after construction, a subclass that
// re-declares a field, and reflection must all match V8.
class Base { kind: number; flags: number; label: string; next: Base | undefined; score: number;
  constructor(kind: number, label: string) { this.kind = kind; this.flags = 0; this.label = label; this.next = undefined; this.score = 0.5; } }
class Leaf extends Base { text: string; constructor(text: string) { super(1, "leaf"); this.text = text; } }
class Pair extends Base { left: Base; right: Base; constructor(l: Base, r: Base) { super(2, "pair"); this.left = l; this.right = r; this.flags = 4; } }
class Odd extends Base { kind: number; constructor() { super(3, "odd"); this.kind = 7.5; } }
function describe(b: Base): string { return b.kind + ":" + b.flags + ":" + b.label + ":" + (b.next ? b.next.kind : "-") + ":" + b.score; }
function main(): void {
  const a = new Leaf("x"), b = new Leaf("y"), p = new Pair(a, b), o = new Odd();
  a.next = p; p.flags |= 8; o.flags = o.kind * 2; b.score += 1.25;
  const all: Base[] = [a, b, p, o];
  let sum = 0; for (const n of all) { sum += n.kind + n.flags; if (n.kind === 2) sum += (n as Pair).left.kind; }
  console.log(sum, all.map(describe).join(" "), Object.keys(o).join(","), JSON.stringify(b), typeof a.kind, a.flags === 0, 1 / o.flags);
}
main();
