// GC bench: binary trees（Boehm GCBench 系クラシック）。深いポインタグラフの
// 構築/破棄で minor 昇格と full mark の両方に圧をかける。短命の木を大量に作り
// つつ一部をリングに保持してエスケープと昇格を強制（SROA/stack 化を防ぐ）。
class TreeNode {
  l: TreeNode | null;
  r: TreeNode | null;
  v: number;
  constructor(l: TreeNode | null, r: TreeNode | null, v: number) {
    this.l = l;
    this.r = r;
    this.v = v;
  }
}
function build(d: number, v: number): TreeNode {
  if (d === 0) return new TreeNode(null, null, v);
  return new TreeNode(build(d - 1, 2 * v), build(d - 1, 2 * v + 1), v);
}
function check(n: TreeNode | null): number {
  if (n === null) return 0;
  return (n.v + check(n.l) + check(n.r)) % 1000000007;
}
function main(): void {
  const keep: (TreeNode | null)[] = [];
  for (let i = 0; i < 8; i++) keep.push(null);
  const longLived = build(14, 1); // full GC の live set（~32k ノード常駐）
  let acc = 0;
  for (let i = 0; i < 150; i++) {
    const t = build(12, i); // 短命の木 ~8k ノード
    acc = (acc + check(t)) % 1000000007;
    if ((i & 7) === 0) keep[(i >> 3) & 7] = t; // 1/8 を保持 → 昇格圧
  }
  acc = (acc + check(longLived)) % 1000000007;
  for (let k = 0; k < 8; k++) acc = (acc + check(keep[k])) % 1000000007;
  console.log("gc_binarytrees " + acc);
}
main();
