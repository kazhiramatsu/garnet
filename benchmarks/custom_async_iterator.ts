class AsyncSeq {
  private i: number; private n: number;
  constructor(n: number) { this.i = 0; this.n = n; }
  [Symbol.asyncIterator](): AsyncSeq { return this; }
  async next(): Promise<{ value: number; done: boolean }> {
    if (this.i < this.n) { const v = this.i; this.i = this.i + 1; return { value: v, done: false }; }
    return { value: 0, done: true };
  }
}
async function main(): Promise<void> {
  let sum = 0;
  for await (const x of new AsyncSeq(5)) { sum = sum + x; }
  console.log(sum);   // 10
}

main();
