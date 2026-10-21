// Field reads and writes on receivers whose static type is a class (locals,
// narrowed unions, optional chains, type parameters constrained by a class,
// downcast results), which the strict type profile compiles to
// struct offsets: values of subclasses through the base class, a wrong
// downcast probed for a field the value lacks (V8: undefined), a receiver a
// non-null assertion lies about (TypeError), writes, numeric fields.
abstract class AstNode {
  readonly kind: number;
  parent: AstNode | undefined;
  flags = 0;
  constructor(kind: number) { this.kind = kind; this.parent = undefined; }
}
class Ident extends AstNode {
  text: string;
  count = 0;
  constructor(text: string) { super(1); this.text = text; }
}
class Num extends AstNode {
  value: number;
  constructor(value: number) { super(2); this.value = value; }
}
class Pair extends AstNode {
  left: AstNode;
  right: AstNode;
  constructor(left: AstNode, right: AstNode) {
    super(3);
    this.left = left; this.right = right;
    left.parent = this; right.parent = this;
  }
}

function rootOf(n: AstNode): AstNode {
  let p = n.parent;
  if (p === undefined) return n;
  for (;;) {
    const q: AstNode | undefined = p.parent;
    if (q === undefined) return p;
    p = q;
  }
}
function sumKinds(n: AstNode | undefined): number {
  let s = 0;
  while (n !== undefined) { s += n.kind; n.flags |= 8; n = n.parent; }
  return s;
}
function textOf(n: AstNode): string {
  const id = n as Ident;
  return id.text !== undefined ? id.text : `<${n.kind}>`;
}
function doubled(n: AstNode): number {
  const x = n as Num;
  return x.value * 2;
}
function valueOf(x: Num): string { return String(x.value); }
function textParam(x: Ident): string | undefined { return x.text; }
function bump(n: AstNode): void {
  if (n instanceof Ident) { n.count += 1; n.text += "!"; }
}
function firstLeaf<T extends AstNode>(n: T): AstNode {
  let cur: AstNode = n;
  while (cur instanceof Pair) cur = cur.left;
  return cur;
}
function kindOfParent(n: AstNode): number | undefined { return n.parent?.kind; }
function liar(n: AstNode | undefined): number { return n!.kind; }
function kinds<T extends AstNode>(xs: T[]): number { let s = 0; for (const x of xs) s += x.kind * 10 + x.flags; return s; }

function main(): void {
  const a = new Ident("a"), b = new Num(5);
  const p = new Pair(a, b), q = new Pair(p, new Ident("c"));
  console.log(rootOf(a) === q, rootOf(q) === q, sumKinds(a), a.flags, p.flags, q.flags);
  console.log(textOf(a), textOf(b), textOf(p), doubled(b), doubled(a), doubled(p));
  console.log(valueOf(b), textParam(a));
  bump(a); bump(a); bump(b);
  console.log(a.count, a.text, firstLeaf(q) === a, kindOfParent(a), kindOfParent(q));
  try { liar(undefined); } catch (e) { console.log((e as Error).constructor.name); }
  const nodes: AstNode[] = [a, b, p, q, new Ident("z"), new Num(-1)];
  let total = 0;
  for (let i = 0; i < 3000; i++) for (const n of nodes) total += n.kind + (n.parent === undefined ? 1 : 0);
  console.log(total, kinds(nodes), kinds([a, new Ident("y")]));
}
main();
export {};
