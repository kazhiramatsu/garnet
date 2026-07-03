function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

function sumDown(n: number): number {
  if (n <= 0) return 0;
  return n + sumDown(n - 1);
}

console.log(fib(0));
console.log(fib(1));
console.log(fib(10));
console.log(sumDown(100));
