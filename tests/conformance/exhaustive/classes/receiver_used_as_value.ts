// A method that uses its receiver as a value (stores it into another object,
// passes it to a free function, copies it) needs a real `this` object even
// when it creates no closure: the receiver must not be scalar-replaced at a
// `new C().m()` call site where the method is inlined.
class Counter {
  constructor(public n: number) {}
  viaRecord(k: number): number {
    const rec = { owner: this };
    return readOwner(rec) + k;
  }
  viaArg(k: number): number { return total(this, k); }
  viaCopy(k: number): number {
    const me = this;
    return me.n * k;
  }
  viaNested(k: number): number {
    const self = this;
    function helper(v: number): number { return self.n + v; }
    function twice(v: number): number { return helper(v) * 2; }
    return twice(k) + helper(1);
  }
}
function readOwner(rec: { owner: Counter }): number { return rec.owner.n; }
function total(c: Counter, k: number): number { return c.n + k; }
function main(): void {
  console.log(new Counter(5).viaRecord(3));
  console.log(new Counter(6).viaArg(4));
  console.log(new Counter(7).viaCopy(2));
  console.log(new Counter(8).viaNested(3));
  const c = new Counter(9);
  console.log(c.viaRecord(1), c.viaArg(1), c.viaCopy(1), c.viaNested(1));
}
main();
