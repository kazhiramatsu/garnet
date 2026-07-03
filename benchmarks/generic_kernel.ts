class Box<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }
function kernel(N: number): number {
  let sum = 0; let i = 0;
  while (i < N) {
    const b = new Box<number>(i % 100);
    sum = (sum + b.get()) % 1000007;
    i = i + 1;
  }
  return sum;
}
function main(): void { console.log(kernel(50000000)); }

main();
