// Recursive walk over an object tree with early returns (checker recursion).
interface Tree { kind: number; left?: Tree; right?: Tree; val: number; }
function build(d: number, i: number): Tree { if (d === 0) return { kind: 0, val: i }; return { kind: 1 + (i & 1), val: i, left: build(d - 1, i * 2), right: build(d - 1, i * 2 + 1) }; }
function walk(t: Tree, depth: number): number {
  if (t.kind === 0) return t.val & 7;
  if (depth > 40) return 0;
  const l = t.left ? walk(t.left, depth + 1) : 0; const r = t.right ? walk(t.right, depth + 1) : 0;
  return t.kind === 1 ? l + r : (l ^ r) + 1;
}
function main(): void { const t = build(14, 1); let sum = 0; for (let r = 0; r < 480; r++) sum += walk(t, 0); console.log(sum); }
main();
