// Enum-typed class fields (int32 values): switches and flag tests on them, stores of enum
// constants and of computed integers, reads through the base type and a subclass, a negative
// member, reflection of a sized instance, and an int32 field beside a double and a boxed one.
const enum Kind { A = 1, B = 2, C = 300, Neg = -7, Big = 2147483647 }
const enum Flags { None = 0, X = 1 << 0, Y = 1 << 3, Z = 1 << 30 }
class Base {
  kind: Kind; flags: Flags; weight: number; label: string;
  constructor(kind: Kind, weight: number, label: string) { this.kind = kind; this.flags = Flags.None; this.weight = weight; this.label = label; }
  has(f: Flags): boolean { return (this.flags & f) !== 0; }
}
class Leaf extends Base { extra: Kind; constructor(kind: Kind, weight: number) { super(kind, weight, "leaf"); this.extra = Kind.Neg; } }
function describe(b: Base): string {
  switch (b.kind) {
    case Kind.A: return "a" + b.weight;
    case Kind.B: return "b" + (b.flags | 0);
    case Kind.C: return "c" + (b.has(Flags.Y) ? "y" : "-");
    case Kind.Neg: return "neg";
    default: return "big" + (b.kind - 2147483640);
  }
}
function main(): void {
  const items: Base[] = [new Base(Kind.A, 1.5, "x"), new Base(Kind.B, 2, "y"), new Leaf(Kind.C, 3), new Base(Kind.Neg, 4, "n"), new Leaf(Kind.Big, 5)];
  items[1].flags |= Flags.X | Flags.Y;
  items[2].flags = Flags.Y;
  items[4].flags = (Flags.Z | Flags.X) & ~Flags.X;
  let acc = 0;
  for (let r = 0; r < 3; r++) for (const it of items) { acc += it.kind + (it.flags >>> 3); if (it.has(Flags.Z)) acc += 2; }
  const out: string[] = [];
  for (const it of items) out.push(describe(it));
  const leaf = items[2] as Leaf;
  leaf.extra = Kind.C;
  leaf.kind = leaf.extra;
  const copy = { ...items[1] };
  console.log(out.join(" "), acc, Object.keys(items[0]).join(","), JSON.stringify(items[4]), leaf.extra, leaf.kind === Kind.C, typeof items[3].kind, copy.flags, items[3].kind + 1, Kind.Neg < 0);
}
main();
