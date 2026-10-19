// An interface that extends Array/ReadonlyArray denotes a runtime array (tsc's
// NodeArray): for-of, length, index reads, builtin methods, spread, and the
// extra properties keep working; unions with undefined narrow first.
interface Nd { kind: number; name?: string; }
interface NodeArray<T extends Nd> extends ReadonlyArray<T> { pos: number; end: number; hasTrailingComma?: boolean; }
interface List<T> extends Array<T> { tag: string; }
function createNodeArray<T extends Nd>(items: T[], pos: number): NodeArray<T> {
  const arr = items.slice() as unknown as NodeArray<T>;
  (arr as any).pos = pos; (arr as any).end = pos + items.length;
  return arr;
}
function createList<T>(items: T[], tag: string): List<T> { const l = items.slice() as List<T>; l.tag = tag; return l; }
function sumKinds(nodes: NodeArray<Nd>): number { let s = 0; for (const n of nodes) s += n.kind; return s; }
function names(nodes: NodeArray<Nd> | undefined): string { if (!nodes) return "-"; let out = ""; for (const n of nodes) out += n.name ?? "?"; return out + nodes.length; }
function firstBig(nodes: NodeArray<Nd>): Nd | undefined { for (let i = 0; i < nodes.length; i++) if (nodes[i].kind > 5) return nodes[i]; return undefined; }
function listOps(l: List<number>): string {
  return [l.length, l.tag, l.map((x) => x * 2).join(","), l.filter((x) => x % 2 === 0).length, l.some((x) => x > 3), l.indexOf(3), l.slice(1).join("|"), [...l].reverse().join("")].join(" ");
}
function takesReadonly(xs: readonly Nd[]): number { return xs.length; }
function main(): void {
  const nodes = createNodeArray([{ kind: 1, name: "a" }, { kind: 7 }, { kind: 3, name: "c" }], 10);
  console.log(sumKinds(nodes), names(nodes), names(undefined), firstBig(nodes)?.kind, nodes.pos, nodes.end, nodes.hasTrailingComma, nodes.length, nodes[1].kind);
  console.log(nodes.map((n) => n.kind).join(","), nodes.filter((n) => n.name).length, nodes.some((n) => n.kind === 7), nodes.every((n) => n.kind > 0), nodes.findIndex((n) => n.kind === 3), nodes.slice(0, 2).length, takesReadonly(nodes));
  const nested: NodeArray<Nd>[] = [nodes, createNodeArray([], 0)];
  let total = 0; for (const na of nested) for (const n of na) total += n.kind;
  console.log(total, nested[1].length, nested[1].pos, Array.isArray(nodes), nodes instanceof Array, JSON.stringify(nodes));
  const l = createList([1, 2, 3, 4], "t");
  console.log(listOps(l), l.push(5), l.length, l.tag, Object.keys(l).join(","));
  for (const x of l) if (x === 5) console.log("five");
  const empty = createNodeArray<Nd>([], 3);
  console.log(sumKinds(empty), names(empty), firstBig(empty), [...empty].length);
}
main();
