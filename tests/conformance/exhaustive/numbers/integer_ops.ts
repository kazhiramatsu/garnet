function main(): void {
  let x = 100, y = 7;
  console.log(x + y, x - y, x * y, Math.floor(x / y), x % y);
  console.log(x & y, x | y, x ^ y, x << 2, x >> 1, x >>> 1);
  console.log(~x, -x, x > y, x <= y, x === 100);
}

main();
