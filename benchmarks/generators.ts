function* accum(): Generator<number, number, number> {
  let total = 0;
  const a = yield total;     // yields 0, receives first .next(v) arg
  total = total + a;
  const b = yield total;     // yields a
  total = total + b;
  return total;              // final value
}
function main(): void {
  const g = accum();
  const r0 = g.next();       // {value:0, done:false}
  console.log(r0.value);     // 0
  const r1 = g.next(10);     // a=10, yields 10
  console.log(r1.value);     // 10
  const r2 = g.next(5);      // b=5, returns 15
  console.log(r2.value);     // 15
  console.log(r2.done ? 1 : 0);  // 1
}

main();
