// User-defined methods that take and invoke callback parameters (the SROA inline
// callee-remap class of bug).
class Calc {
  constructor(public n: number) {}
  apply(f: (x: number) => number): number { return f(this.n); }
  apply2(f: (x: number) => number, g: (x: number) => number): number { return g(f(this.n)); }
  pipe(fs: ((x: number) => number)[]): number { let r = this.n; for (const f of fs) r = f(r); return r; }
}
class Wrap<T> {
  constructor(public v: T) {}
  map<U>(f: (t: T) => U): Wrap<U> { return new Wrap(f(this.v)); }
  get(): T { return this.v; }
}
function main(): void {
  const c = new Calc(10);
  console.log(c.apply(x => x + 5));                       // 15
  console.log(c.apply2(x => x * 2, x => x + 1));          // 21
  console.log(c.pipe([x => x + 1, x => x * 3, x => x - 2]));// 31
  console.log(new Wrap(3).map(x => x * x).map(x => "r" + x).get());  // r9
  const ws = [new Wrap(1), new Wrap(2)];
  console.log(ws.map(w => w.map(x => x + 10).get()).join(","));      // 11,12
}
main();
