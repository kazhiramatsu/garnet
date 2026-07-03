// GC bench: 閉サイクル churn（クラシック）。prev/next 相互参照の 100 ノード
// 閉サイクルを大量に作り、アンカー上書きで丸ごと到達不能にする — 参照カウント
// では回収できない「純粋なサイクルごみ」の mark/sweep 回収を踏むのが狙い。
// live set は 16 サイクル（1,600 ノード）に有界で、マーク再帰も浅い。
// 注: 深い「一本鎖」(数十万ノード) は現行 GC の再帰マークがスタック溢れする
// 既知の弱点（gc_scan_refs の worklist 化 = P2a/P6 課題）。本 fixture は
// その修正後も回帰検知として機能する。
class LinkNode {
  next: LinkNode | null;
  prev: LinkNode | null;
  v: number;
  constructor(v: number) {
    this.next = null;
    this.prev = null;
    this.v = v;
  }
}
function segment(base: number, len: number): LinkNode {
  // len ノードの双方向・閉サイクル（先頭を返す）
  const head = new LinkNode(base);
  let cur = head;
  for (let i = 1; i < len; i++) {
    const n = new LinkNode(base + i);
    cur.next = n;
    n.prev = cur;
    cur = n;
  }
  cur.next = head;
  head.prev = cur;
  return head;
}
function main(): void {
  const anchors: (LinkNode | null)[] = [];
  for (let i = 0; i < 16; i++) anchors.push(null);
  let acc = 0;
  for (let i = 0; i < 12000; i++) {
    const s = segment(i, 100);
    anchors[i & 15] = s; // 旧サイクルが丸ごと到達不能に
    let cur: LinkNode | null = s;
    for (let k = 0; k < 4; k++) {
      if (cur !== null) {
        acc = (acc + cur.v) % 1000000007;
        cur = cur.next;
      }
    }
  }
  // live なサイクルを一周して checksum（サイクル維持の検証を兼ねる）
  for (let a = 0; a < 16; a++) {
    const head = anchors[a];
    if (head === null) continue;
    let cur: LinkNode | null = head.next;
    let steps = 0;
    while (cur !== null && cur !== head && steps < 200) {
      acc = (acc + cur.v) % 1000000007;
      cur = cur.next;
      steps++;
    }
  }
  console.log("gc_cycles " + acc);
}
main();
