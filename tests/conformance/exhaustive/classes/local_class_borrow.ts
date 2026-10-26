// A class declared inside a function gets a fresh prototype each time the
// declaration is evaluated; its methods are the same functions. Borrowing one
// (`call`, `apply`, `bind`) with an instance of any evaluation of the class
// is a call on an instance of the method's class, in a closed program too.
function make(tag: string) {
  class Local {
    n = 1;
    tag: string;
    constructor() { this.tag = tag; }
    describe(): string { return this.tag + ":" + this.n; }
    bump(by: number): number { this.n += by; return this.n; }
  }
  return Local;
}
class Top {
  static made = 0;
  static count(): number { return ++Top.made; }
  v = 10;
  get(): number { return this.v; }
}
function main(): void {
  const A = make("a");
  const B = make("b");
  const a = new A();
  const b = new B();
  console.log(a.describe.call(a), b.describe.call(b));           // a:1 b:1
  console.log(a.bump.apply(a, [2]), b.bump.bind(b)(5));          // 3 6
  console.log(A.prototype.describe.call(b));                     // b:6   (same method, another evaluation's instance)
  console.log(a instanceof A, a instanceof B, A === B);          // true false false
  class LocalBase {
    n = 1;
    describe(): string { return "s:" + this.n; }
    bump(by: number): number { this.n += by; return this.n; }
  }
  class Sub extends LocalBase {
    extra = 7;
    describe(): string { return super.describe() + "+" + this.extra; }
  }
  const s = new Sub();
  console.log(s.describe(), s.describe.call(s), s.bump.call(s, 1)); // s:1+7 s:1+7 2
  const t = new Top();
  console.log(t.get.call(t), t.get.bind(t)(), Top.count.call(null), Top.count.bind(null)()); // 10 10 1 2
  for (let i = 0; i < 2; i++) {
    class Loop { k = i; key(): number { return this.k * 100; } }
    const l = new Loop();
    console.log(l.key.call(l), l.key.bind(l)());                   // 0 0 / 100 100
  }
}
main();
