class Base<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }
class IntBox extends Base<number> { constructor(v: number) { super(v); } }
function kernel(N: number): number {
  let sum = 0; let i = 0;
  while (i < N) { const b = new IntBox(i % 100); sum = (sum + b.get()) % 1000007; i = i + 1; }
  return sum;
}
function main(): void { console.log(kernel(20000000)); }

main();
