// SROA 健全性 (s316): null-narrowing はレシーバの Copy 別名や入れ子ブロック
// （if / 三項 / while 本体）越しに参照値を観測する。旧実装は
//  (a) 別名越しの観測が失格網をすり抜けて dematerialize が誤発火し、
//  (b) 外側 body が落とした `Copy xn←x` の別名マップが入れ子 rewrite に
//      伝播せず、入れ子内の x.field 読みが未書き換えのまま undefined を読む
// silent miscompile だった（narrowing 直後の 2 回目の読みが TypeError/undefined 化）。
class Inner {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}
class Outer {
  b: Inner | null;
  constructor(b: Inner | null) {
    this.b = b;
  }
}
class Node2 {
  next: Node2 | null;
  v: number;
  constructor(next: Node2 | null, v: number) {
    this.next = next;
    this.v = v;
  }
}
function main(): void {
  // if 本体内の narrowed 読み
  const x = new Outer(new Inner(5));
  if (x.b !== null) console.log("if", x.b.v);
  // 三項内の narrowed 連鎖読み
  const a = new Node2(null, 7);
  const b = new Node2(a, 8);
  const u = b.next !== null ? b.next.next : null;
  console.log("ternary", u === null);
  // while 本体内の narrowed ローカル遷移
  let c: Node2 | null = new Node2(null, 9);
  let k = 0;
  while (k < 5) {
    if (c === null) {
      console.log("isnull", k);
      break;
    }
    console.log("iter", k, c.v);
    c = c.next;
    k++;
  }
  const y = new Outer(null);
  console.log("nullfield", y.b === null);
}
main();
