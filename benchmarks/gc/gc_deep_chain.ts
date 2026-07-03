// GC bench: 深い一本鎖（3×10^5 ノード）。合法な JS だが、再帰マークだと
// C スタックが溢れて SIGSEGV するケースの回帰検知（gc_moving_plan Phase A）。
// 鎖を live に保ったまま追加 alloc で minor GC を複数回踏ませ、深いマークを
// 強制する。マークの深さ = 鎖長なので worklist 実装の pause 指標も兼ねる。
// （s316: 本 fixture は containment escape バグ = 「配列/フィールドにしか
//   格納されないループ内 class alloc が stack 化され全要素が同一セルに潰れる」
//   silent miscompile の発見と修正の契機にもなった。走査 checksum はその回帰検知。）
class ChainNode {
  next: ChainNode | null;
  v: number;
  constructor(next: ChainNode | null, v: number) {
    this.next = next;
    this.v = v;
  }
}
function main(): void {
  let head: ChainNode | null = null;
  for (let i = 0; i < 300000; i++) head = new ChainNode(head, i);
  // 鎖が live な状態で短命 alloc を続けて minor GC を複数回踏ませる
  const pad: ({ a: number } | null)[] = [];
  for (let i = 0; i < 64; i++) pad.push(null);
  for (let i = 0; i < 200000; i++) pad[i & 63] = { a: i };
  let acc = 0;
  let cur: ChainNode | null = head;
  while (cur !== null) {
    acc = (acc + cur.v) % 1000000007;
    cur = cur.next;
  }
  console.log("gc_deep_chain " + acc);
}
main();
