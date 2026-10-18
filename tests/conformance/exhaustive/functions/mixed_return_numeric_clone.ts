// A function whose return merges a number with a non-number must not get a
// numeric (f64/i64) direct-call clone: the clone would reinterpret the boolean
// or undefined as NaN. (The merge local used to count as numeric when ANY of
// its definitions was numeric.)
function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); }
function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1); }
function pick(n: number): number | boolean { return n > 0 ? n * 2 : false; }
function maybe(n: number): number | undefined { return n > 0 ? n + 1 : undefined; }
function twoWay(n: number): number {
  let r;
  if (n > 5) r = n * 10; else r = n - 1;
  return r;
}
function reassigned(n: number): number | string {
  let v: number | string = n;
  if (n < 0) v = "neg";
  return v;
}
function main(): void {
  console.log(isEven(10), isEven(7), isOdd(3));
  console.log(pick(4), pick(0), pick(-2));
  console.log(maybe(2), maybe(0));
  console.log(twoWay(7), twoWay(2));
  console.log(reassigned(3), reassigned(-3));
}
main();
