type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface TreeNode<T> { value: T; children: TreeNode<T>[]; }
type LinkedList<T> = { head: T; tail: LinkedList<T> } | null;

function sumTree(n: TreeNode<number>): number {
  let s = n.value;
  for (const c of n.children) s += sumTree(c);
  return s;
}
function listLen<T>(l: LinkedList<T>): number {
  let n = 0; let cur = l;
  while (cur !== null) { n++; cur = cur.tail; }
  return n;
}
function depth(j: Json): number {
  if (Array.isArray(j)) { let m = 0; for (const x of j) m = Math.max(m, depth(x)); return m + 1; }
  if (j !== null && typeof j === "object") { let m = 0; for (const k in j) m = Math.max(m, depth(j[k])); return m + 1; }
  return 0;
}
function main(): void {
  const t: TreeNode<number> = { value: 1, children: [{ value: 2, children: [] }, { value: 3, children: [{ value: 4, children: [] }] }] };
  console.log(sumTree(t));                          // 10
  const l: LinkedList<number> = { head: 1, tail: { head: 2, tail: { head: 3, tail: null } } };
  console.log(listLen(l));                          // 3
  const j: Json = { a: [1, { b: [2, 3] }], c: "x" };
  console.log(depth(j));                            // 3
}
main();
