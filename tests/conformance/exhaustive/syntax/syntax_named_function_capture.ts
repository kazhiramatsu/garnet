function main(): void {
  const recur = 99;
  const offset = 2;
  const factorialPlus = function recur(n: number): number {
    if (n <= 1) return offset;
    return n * recur(n - 1);
  };

  const even = function self(n: number): boolean {
    return n === 0 || !self(n - 1);
  };

  console.log(factorialPlus(4), even(8), even(7), recur);
}

main();
