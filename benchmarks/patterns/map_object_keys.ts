// Side tables keyed by nodes, as a checker keeps them: a Map<object, T> and a
// Set<object> probed with the objects themselves, hits and misses mixed.
class AstNode { constructor(public kind: number, public pos: number) {} }
function main() {
  const n = 20000;
  const nodes: AstNode[] = [];
  for (let i = 0; i < n; i++) nodes.push(new AstNode(i & 63, i));
  const links = new Map<AstNode, number>();
  const seen = new Set<AstNode>();
  for (let i = 0; i < n; i += 2) { links.set(nodes[i], i); seen.add(nodes[i]); }
  let hits = 0;
  let sum = 0;
  for (let rep = 0; rep < 400; rep++) {
    for (let i = 0; i < n; i++) {
      const node = nodes[(i * 7919) % n];
      const v = links.get(node);
      if (v !== undefined) { hits++; sum = (sum + v) | 0; }
      if (seen.has(node)) sum = (sum + 1) | 0;
    }
  }
  console.log(hits, sum, links.size, seen.size);
}
main();
