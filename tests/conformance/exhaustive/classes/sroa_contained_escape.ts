// SROA/escape 健全性 (s316): 「コンテナに格納されるだけのループ内 class alloc」は
// 関数レベルでは NoEscape でも反復を跨いで生存するため、per-iteration stack slot に
// してはならない。旧実装は arr.push / arr[i]=x の要素が全て単一のスタックセルに
// 潰れて最終値になる silent miscompile だった（識別同値 s[0]===s[5] まで真になる）。
// 連結リストの null 終端走査（cur = cur.next）が自己ループ化して無限ループする形も同根。
class Boxed {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}
class Link {
  next: Link | null;
  v: number;
  constructor(next: Link | null, v: number) {
    this.next = next;
    this.v = v;
  }
}
function pushLoop(): void {
  const s: Boxed[] = [];
  for (let i = 0; i < 6; i++) {
    const n = new Boxed(i);
    s.push(n);
  }
  console.log("push", s.length, s[0].v, s[5].v, s[0] === s[5]);
}
function indexLoop(): void {
  const s: (Boxed | null)[] = [];
  for (let i = 0; i < 6; i++) s.push(null);
  for (let i = 0; i < 6; i++) s[i] = new Boxed(i * 10);
  const a = s[0];
  const b = s[5];
  console.log("index", a !== null ? a.v : -1, b !== null ? b.v : -1, a === b);
}
function chainLoop(): void {
  let head: Link | null = null;
  for (let i = 0; i < 10; i++) head = new Link(head, i);
  let acc = 0;
  let cur: Link | null = head;
  while (cur !== null) {
    acc = (acc + cur.v) % 1000000007;
    cur = cur.next;
  }
  console.log("chain", acc);
}
function main(): void {
  pushLoop();
  indexLoop();
  chainLoop();
}
main();
