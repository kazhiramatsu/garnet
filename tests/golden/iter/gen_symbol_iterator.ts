class R { *[Symbol.iterator]() { yield 10; yield 20; yield 30; yield 40; } }
class Pair { a: number; b: number; constructor(a: number, b: number){ this.a=a; this.b=b; }
  *[Symbol.iterator]() { yield this.a; yield this.b; } }
function main(): void {
  let s = 0;
  for (const x of new R()) { s = s + x; if (x === 20) break; }
  console.log(s);                       // 30 (break closes iterator)
  let t = 0;
  for (const v of new Pair(3, 4)) t = t + v;
  console.log(t);                       // 7
  let u = 0;
  for (const x of new R()) u = u + x;
  for (const x of new R()) u = u + x;   // fresh generator each time
  console.log(u);                       // 200
}

main();
