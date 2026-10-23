// Map.get / Map.has / Set.has with keys the program types as strings or as
// references, probed in line: string keys in every representation (immediate,
// heap, slice view, two-byte, empty), object keys (class instances, plain
// objects, arrays, functions), keys that lie about their type through `any`
// (a number behind `string`, null and undefined behind an object type), a
// WeakMap and a WeakSet, maps below and above the index threshold, deletes,
// and a receiver that is not a Map behind the type.
class AstNode { constructor(public id: number) {} }
function strKey(i: number): string {
  return i % 5 === 0 ? "k" + i : i % 5 === 1 ? ("key_" + i).slice(0, 5 + (i % 3)) : i % 5 === 2 ? "λ" + i : i % 5 === 3 ? "" + i : "longer_identifier_name_" + i;
}
function main() {
  const out: unknown[] = [];
  for (const n of [4, 12, 400]) {
    const m = new Map<string, number>();
    const s = new Set<string>();
    for (let i = 0; i < n; i++) { m.set(strKey(i), i); if (i % 2 === 0) s.add(strKey(i)); }
    m.set("", -1);
    let sum = 0, has = 0, inSet = 0;
    for (let i = 0; i < n + 5; i++) {
      const k = strKey(i).split("").join("");
      const v = m.get(k);
      if (v !== undefined) sum += v;
      if (m.has(k)) has++;
      if (s.has(k)) inSet++;
    }
    for (let i = 0; i < n; i += 4) { m.delete(strKey(i)); s.delete(strKey(i)); }
    let after = 0;
    for (let i = 0; i < n; i++) { if (m.has(strKey(i))) after++; if (s.has(strKey(i))) after++; }
    out.push([n, sum, has, inSet, after, m.get(""), m.has(""), s.has("")]);
    const lying = 7 as unknown as string;
    out.push([m.get(lying), m.has(lying), s.has(lying)]);
    const nodes: AstNode[] = [];
    for (let i = 0; i < n; i++) nodes.push(new AstNode(i));
    const links = new Map<AstNode, string>();
    const seen = new Set<AstNode>();
    for (let i = 0; i < n; i += 3) { links.set(nodes[i], "n" + i); seen.add(nodes[i]); }
    let hit = 0, miss = 0, inSeen = 0;
    for (const node of nodes) { const v = links.get(node); if (v !== undefined) hit++; else miss++; if (links.has(node)) hit++; if (seen.has(node)) inSeen++; }
    out.push([hit, miss, inSeen, links.get(new AstNode(0)), links.has(nodes[0]), seen.has(nodes[1])]);
    const nul = null as unknown as AstNode;
    const und = undefined as unknown as AstNode;
    const prim = 3 as unknown as AstNode;
    out.push([links.get(nul), links.has(und), seen.has(prim), links.get(und)]);
  }
  const fns = new Map<() => number, number>();
  const f1 = () => 1, f2 = () => 2;
  fns.set(f1, 1); fns.set(f2, 2);
  const arrKey: number[] = [1];
  const objs = new Map<object, string>([[arrKey, "arr"], [{}, "obj"]]);
  out.push([fns.get(f1), fns.get(f2), fns.get(() => 3), fns.has(f2), objs.get(arrKey), objs.get([1]), objs.has(arrKey)]);
  const weak = new WeakMap<AstNode, number>();
  const wset = new WeakSet<AstNode>();
  const wk = new AstNode(99);
  weak.set(wk, 1); wset.add(wk);
  out.push([weak.get(wk), weak.has(new AstNode(99)), wset.has(wk)]);
  const notMap = { get: (k: string) => k.length, has: (k: string) => k.length > 2 } as unknown as Map<string, number>;
  out.push([notMap.get("abc"), notMap.has("ab")]);
  console.log(JSON.stringify(out));
}
main();
