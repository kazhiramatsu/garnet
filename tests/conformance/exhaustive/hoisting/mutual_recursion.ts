function main(): void {
  console.log(isEven(10));
  console.log(isEven(7));
  function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); }
  function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1); }
}
main();
