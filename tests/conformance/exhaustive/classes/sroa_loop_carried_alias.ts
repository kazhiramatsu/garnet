// SROA 健全性 (s317 #4): ループ底部の Copy alias（head = n）は逆辺を跨いで
// 次イテレーション先頭の観測（n.next = head の src 使用）に届かなければならない。
// 線形 1 パスの失格網は StoreField の dq(head) 時点で alias 未記録のため漏れ、
// SROA が「head = n」ストアごと alloc を消して連鎖の head が null に潰れていた
// （chain 0。V8 は正しい合計を出す）。scan の 2 パス化で失格させる。
class Node {
  v: number;
  next: Node | null;
  constructor(v: number) {
    this.v = v;
    this.next = null;
  }
}
function buildChain(n: number): number {
  let head: Node | null = null;
  for (let i = 0; i < n; i++) {
    const node = new Node(i);
    node.next = head;
    head = node;
  }
  let sum = 0;
  let p = head;
  while (p) {
    sum = (sum + p.v) % 1000000007;
    p = p.next;
  }
  return sum;
}
function lastTracker(n: number): number {
  // 変種: copy 先がループ後に読まれる（last = node）。フィールド読みだけなら
  // スカラー化は合法だが、次イテレーションの node.next = last が実体を要求する。
  let last: Node | null = null;
  for (let i = 0; i < n; i++) {
    const node = new Node(i * 10);
    node.next = last;
    last = node;
  }
  return last ? last.v + (last.next ? last.next.v : -100) : -1;
}
function main(): void {
  console.log(buildChain(10000)); // 49995000 % 1000000007 = 49995000
  console.log(buildChain(0)); // 0
  console.log(lastTracker(3)); // 20 + 10 = 30
  console.log(lastTracker(1)); // 0 + (-100) = -100
  console.log(lastTracker(0)); // -1
}
main();
