function pick<T>(x: T): T { return x; }
function kernel(N: number): number {
  let sum = 0; let i = 0;
  while (i < N) { sum = (sum + pick<number>(i % 1000)) % 1000007; i = i + 1; }
  return sum;
}
function main(): void { console.log(kernel(100000000)); }

main();
