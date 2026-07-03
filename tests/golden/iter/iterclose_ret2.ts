class MyRange {
  private i: number; private n: number;
  constructor(n: number) { this.i = 0; this.n = n; }
  [Symbol.iterator](): MyRange { return this; }
  next(): { value: number; done: boolean } {
    if (this.i < this.n) { const v = this.i; this.i = this.i + 1; return { value: v, done: false }; }
    return { value: 0, done: true };
  }
  return(): { value: number; done: boolean } { console.log("closed"); return { value: 0, done: true }; }
}
function main(): void {
  for (const x of new MyRange(3)) { console.log(x); }   // natural end -> NO "closed"
  console.log("end");
}

main();
