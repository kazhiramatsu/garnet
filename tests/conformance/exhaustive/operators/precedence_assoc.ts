function main(): void {
  console.log(2 + 3 * 4);            // 14
  console.log((2 + 3) * 4);          // 20
  console.log(2 - 3 - 4);            // -5 (left assoc)
  console.log(2 ** 3 ** 2);          // 512 (right assoc)
  console.log(-(2 ** 2));            // tsc: -(2**2) = -4
  console.log(10 / 2 / 5);           // 1
  console.log(1 + 2 << 3);           // 24 ((1+2)<<3)
  console.log(5 & 3 | 8);            // 9
  console.log(1 ? 2 ? 3 : 4 : 5);    // 3 (ternary right assoc)
  console.log(true || false && false); // true (&& binds tighter)
  console.log(7 % 3 + 1);            // 2
  console.log(2 * 3 % 4);            // 2
  let x = 1; console.log(x++ + ++x); // 1 + 3 = 4
  console.log(~5 + 1);               // -5
  console.log(!!0, !!1, !"" , !"a"); // false true true false
}
main();
