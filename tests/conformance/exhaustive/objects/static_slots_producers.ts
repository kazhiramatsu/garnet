// Static slots from producers (docs/static_slots_design.md, producers): a
// fresh object from a construction or a producer call, extended by the stores
// that follow before it escapes, predicts the slots of the keys added after the
// constructor (`id`, `symbol`, `objectFlags`, `value`, `freshType` in the
// compiler). The predictions are validated by the runtime, so every observable
// result must match V8: chains of producer functions (constructor -> createType
// -> withSymbol -> object type), a method-resolved producer, a producer whose
// base is chosen by the callee's name, conditional stores of existing keys,
// stores after an escape, a key whose slot differs between producers (three
// slots), a producer that returns another object, a sequence whose variable is
// reassigned, literals of the same interface, and key order.
interface Ty { flags: number; id?: number; symbol?: string; objectFlags?: number; value?: string; regularType?: Ty; freshType?: Ty; types?: Ty[]; checker?: string; intrinsicName?: string; }
function TypeF(this: Ty, checker: string, flags: number): void { this.flags = flags; if (flags < 0) this.checker = checker; }
const TypeCtor = TypeF as unknown as new (checker: string, flags: number) => Ty;
let typeCount = 0;
const trace: string[] = [];
function createType(flags: number): Ty {
  const result = new TypeCtor("chk", flags);
  typeCount++;
  result.id = typeCount;
  trace.push("t" + typeCount);
  return result;
}
function createTypeWithSymbol(flags: number, symbol: string): Ty {
  const result = createType(flags);
  result.symbol = symbol;
  return result;
}
function createObjectType(objectFlags: number, symbol: string): Ty {
  const type = createTypeWithSymbol(8, symbol);
  type.objectFlags = objectFlags;
  type.types = undefined;
  return type;
}
function createIntrinsicType(flags: number, name: string): Ty {
  const type = createType(flags);
  type.intrinsicName = name;
  type.objectFlags = 1024;
  return type;
}
function createUnionType(types: Ty[]): Ty {
  const result = createType(16);
  result.objectFlags = 2;
  result.types = types;
  return result;
}
function createLiteralType(flags: number, value: string, symbol: string, regularType?: Ty): Ty {
  const type = createTypeWithSymbol(flags, symbol);
  type.value = value;
  type.regularType = regularType || type;
  return type;
}
function getFreshType(type: Ty): Ty {
  if (!type.freshType) {
    const fresh = createLiteralType(type.flags, type.value!, type.symbol!, type);
    fresh.freshType = fresh;
    type.freshType = fresh;
  }
  return type.freshType;
}
interface Nd { pos: number; end: number; kind: number; id: number; flags: number; parent?: Nd; symbol?: string; localSymbol?: string; escapedText?: string; jsDoc?: string; name?: Nd; initializer?: Nd; }
function NodeF(this: Nd, kind: number, pos: number, end: number): void { this.pos = pos; this.end = end; this.kind = kind; this.id = 0; this.flags = 0; this.parent = undefined; }
function IdentifierF(this: Nd, kind: number, pos: number, end: number): void { this.pos = pos; this.end = end; this.kind = kind; this.id = 0; this.flags = 0; this.parent = undefined; }
type NdCtor = new (kind: number, pos: number, end: number) => Nd;
function createBaseNodeFactory() {
  let NodeConstructor: NdCtor | undefined;
  let IdentifierConstructor: NdCtor | undefined;
  return { createBaseNode, createBaseIdentifierNode };
  function createBaseNode(kind: number): Nd { return new (NodeConstructor || (NodeConstructor = NodeF as unknown as NdCtor))(kind, -1, -1); }
  function createBaseIdentifierNode(kind: number): Nd { return new (IdentifierConstructor || (IdentifierConstructor = IdentifierF as unknown as NdCtor))(kind, -1, -1); }
}
const baseFactory = createBaseNodeFactory();
function createBaseDeclaration(kind: number): Nd {
  const node = baseFactory.createBaseNode(kind);
  node.symbol = undefined;
  node.localSymbol = undefined;
  return node;
}
function createBaseIdentifier(escapedText: string): Nd {
  const node = baseFactory.createBaseIdentifierNode(80);
  node.escapedText = escapedText;
  node.jsDoc = undefined;
  node.symbol = undefined;
  return node;
}
function createIdentifier(text: string): Nd {
  const node = createBaseIdentifier(text);
  if (text === "await") node.flags |= 32;
  return node;
}
function createVariableDeclaration(name: Nd, initializer: Nd | undefined): Nd {
  const node = createBaseDeclaration(260);
  node.name = name;
  node.initializer = initializer;
  node.flags |= (node.name.flags & 32) ? 64 : 0;
  node.jsDoc = undefined;
  return node;
}
function createParent(child: Nd): Nd {
  let node = createBaseDeclaration(300);
  trace.push("p" + node.kind);
  node.name = child;
  node = createBaseIdentifier("re");   // reassigned: a second sequence on the same variable
  node.jsDoc = "doc";
  return node;
}
function describeTy(t: Ty): string { return [t.flags, t.id, t.symbol, t.objectFlags, t.value, t.regularType === t ? "self" : t.regularType?.id, t.freshType?.id, t.types?.length, t.intrinsicName, t.checker].join("/"); }
function describeNd(n: Nd): string { return [n.kind, n.pos, n.end, n.id, n.flags, n.parent?.kind, n.symbol, n.localSymbol, n.escapedText, n.jsDoc, n.name?.escapedText, n.initializer?.kind].join("/"); }
function objectFlagsOf(t: Ty): number { return t.objectFlags ?? -1; }
function main(): void {
  const a = createObjectType(4, "A"), b = createIntrinsicType(1, "any"), u = createUnionType([a, b]);
  const lit = createLiteralType(128, "x", "L");
  const fresh = getFreshType(lit), fresh2 = getFreshType(lit);
  const neg = new TypeCtor("negchk", -5);
  console.log(describeTy(a), describeTy(b), describeTy(u), describeTy(lit), describeTy(fresh), fresh === fresh2, describeTy(neg));
  console.log(objectFlagsOf(a), objectFlagsOf(b), objectFlagsOf(u), objectFlagsOf(lit), objectFlagsOf(neg), Object.keys(a).join(","), Object.keys(b).join(","), Object.keys(lit).join(","), Object.keys(fresh).join(","));
  a.objectFlags = 5; u.objectFlags! |= 64; b.objectFlags = 2048; lit.value = "y";
  console.log(a.objectFlags, u.objectFlags, b.objectFlags, lit.value, fresh.value, trace.join(" "));
  const id1 = createIdentifier("foo"), id2 = createIdentifier("await");
  const decl = createVariableDeclaration(id1, id2), decl2 = createVariableDeclaration(id2, undefined);
  const par = createParent(id1);
  console.log(describeNd(id1), describeNd(id2), describeNd(decl), describeNd(decl2), describeNd(par));
  console.log(Object.keys(id1).join(","), Object.keys(decl).join(","), Object.keys(par).join(","));
  decl.symbol = "S"; id1.symbol = "I"; decl.name = id2; id2.escapedText = "changed"; par.jsDoc = undefined;
  console.log(decl.symbol, id1.symbol, decl.name.escapedText, id2.escapedText, par.jsDoc, decl.localSymbol);
  // literals typed as the interface: the same key order hits, another misses
  const litTy: Ty = { flags: 1, id: 99, symbol: "lit" };
  const otherTy: Ty = { id: 98, flags: 2, symbol: "other", objectFlags: 7 };
  console.log(describeTy(litTy), describeTy(otherTy), objectFlagsOf(litTy), objectFlagsOf(otherTy), litTy.id, otherTy.id);
  // many objects through the chains
  let sum = 0;
  const types: Ty[] = [];
  for (let i = 0; i < 5000; i++) types.push(i % 3 === 0 ? createObjectType(i, "s" + i) : i % 3 === 1 ? createIntrinsicType(i, "n" + i) : createUnionType([a]));
  for (const t of types) sum += t.id! + objectFlagsOf(t) + (t.symbol ? 1 : 0) + (t.types ? 2 : 0);
  const nodes: Nd[] = [];
  for (let i = 0; i < 5000; i++) nodes.push(i % 2 ? createIdentifier("n" + i) : createVariableDeclaration(id1, id2));
  for (const n of nodes) sum += n.kind + n.flags + (n.symbol ? 1 : 0) + (n.escapedText ? n.escapedText.length : 0) + (n.name ? 3 : 0);
  console.log(sum, typeCount, types[4999].id, nodes[4999].escapedText, nodes[4998].name === id1);
}
main();
