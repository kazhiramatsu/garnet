// tsc Nd pattern: interface-typed literals from a factory, shape-polymorphic reads/writes.
interface Nd { kind: number; flags: number; pos: number; parent?: Nd; name?: string; extra?: number; }
function make(i: number, parent: Nd | undefined): Nd {
  const k = i % 7;
  if (k === 0) return { kind: k, flags: 0, pos: i, parent };
  if (k === 1) return { kind: k, flags: 1, pos: i, parent, name: "n" };
  if (k === 2) return { kind: k, flags: 2, pos: i, parent, extra: i };
  if (k === 3) return { kind: k, flags: 3, pos: i, parent, name: "m", extra: i };
  return { kind: k, flags: 4, pos: i, parent };
}
function main(): void {
  const nodes: Nd[] = []; let root = make(0, undefined); nodes.push(root);
  for (let i = 1; i < 2000; i++) { const n = make(i, nodes[i >> 1]); nodes.push(n); }
  let sum = 0;
  for (let r = 0; r < 16000; r++) {
    for (let i = 0; i < nodes.length; i++) { const n = nodes[i];
      if (n.kind === 3) n.flags |= 8; sum += n.kind + (n.flags & 3) + n.pos;
      const p = n.parent; if (p !== undefined && (p.flags & 1)) sum += p.kind; } }
  console.log(sum);
}
main();
