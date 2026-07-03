class MyRange {
  private i: number;
  private n: number;
  constructor(n: number) { this.i = 0; this.n = n; }
  [Symbol.iterator](): MyRange { return this; }
  next(): { value: number; done: boolean } {
    if (this.i < this.n) { const v = this.i; this.i = this.i + 1; return { value: v, done: false }; }
    return { value: 0, done: true };
  }
}
function main(): void {
  let sum = 0;
  for (const x of new MyRange(5)) { sum = sum + x; }
  console.log(sum);   // 10
}

main();
