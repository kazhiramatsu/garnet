class Counter {
  private i: number; private max: number;
  constructor(max: number) { this.i = 0; this.max = max; }
  [Symbol.iterator](): Counter { return this; }
  next(): { value: number; done: boolean } {
    if (this.i < this.max) { const v = this.i; this.i = this.i + 1; return { value: v, done: false }; }
    return { value: 0, done: true };
  }
}
function* wrap(): Generator<number> {
  yield 100;
  yield* new Counter(3);    // yield* over a custom iterator
  yield 200;
}
function main(): void {
  let out = "";
  for (const x of wrap()) { out = out + x + ","; }
  console.log(out);   // 100,0,1,2,200,
}

main();
