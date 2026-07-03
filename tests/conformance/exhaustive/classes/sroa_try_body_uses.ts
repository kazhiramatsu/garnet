// SROA 健全性 (s316): try/catch/finally 本体は qualification の scan と rewrite の
// 両方が降りる必要がある。旧実装はどちらも降りず、
//  (a) try 内の読みが未書き換えのまま dematerialize 済みレシーバを読んで undefined、
//  (b) try 内の push 等の失格観測が漏れて誤って dematerialize、
// の二重穴だった。
class Cell {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}
function readInTry(): void {
  const m = new Cell(9);
  try {
    console.log("try-read", m.v);
  } catch (e) {
    console.log("err");
  }
  console.log("after", m.v + 1);
}
function pushInTry(): void {
  const s: Cell[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const n = new Cell(i);
      s.push(n);
    }
  } catch (e) {
    console.log("err");
  }
  console.log("try-push", s.length, s[0].v, s[2].v, s[0] === s[2]);
}
function readInFinally(): void {
  const m = new Cell(3);
  let acc = 0;
  try {
    acc += m.v;
  } finally {
    acc += m.v * 10;
  }
  console.log("finally", acc);
}
function main(): void {
  readInTry();
  pushInTry();
  readInFinally();
}
main();
