// SROA 健全性: 失格網(scan)と rewrite のインライン条件は鏡像でなければならない。
// scan が許すのに rewrite がインライン化できない Direct 呼び出しが残ると、
// 「alloc は除去・call は残置」= 未代入レシーバ/引数からの野生ポインタ読みになる
// （ゴミ値・ハングとして観測。try 不要で踏めるため s316 #2c 以前から潜在の穴）。
//  (a) callee の return が if 内（非 tail）→ inline_callee 不成立
//  (b) callee の return が try/catch 内 → 同上
//  (c) optional 引数の省略呼び出し（arity 不一致）→ inline_free_fn 不成立
// 注: 観測は数値のみに固定（凍結 analyzer_ts は本バグの双子を持ち、wild tsv の
// 文字列連結はハングし得る。数値加算は生ビット再解釈で有限に落ちるため、
// selfconf 側は「有限の DIFF」として既知リストで管理できる）。
class Pick {
  f: number = 7;
  pick(c: boolean): number {
    if (c) {
      return this.f + 1;
    }
    return this.f + 2;
  }
}
class Guard {
  g: number = 9;
  guard(v: number): number {
    try {
      if (v < 0) throw new Error("neg");
      return this.g + v;
    } catch (e: any) {
      return this.g - v;
    }
  }
}
class Box {
  a: number = 3;
}
function readBox(o: Box, x?: number): number {
  return o.a;
}
function main(): void {
  const p = new Pick();
  console.log(p.pick(true), p.pick(false)); // 8 9
  const q = new Guard();
  console.log(q.guard(2), q.guard(-2)); // 11 11
  const b = new Box();
  console.log(readBox(b)); // 3 (arity 1 < params 2: 非インライン呼び出しが残る)
  console.log(readBox(b, 5)); // 3 (全 arity: インライン経路と混在させ両方を踏む)
}
main();
