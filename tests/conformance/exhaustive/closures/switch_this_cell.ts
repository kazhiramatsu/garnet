// Arrows that use `this` created in different `switch` cases: the lexical-this
// cell must exist on every path that creates one, not only after the first
// case's. Also a loop whose later iteration creates the first arrow, a nested
// arrow, and an arrow that escapes and runs after the method returned.
class R {
  x = 1;
  y = 2;
  kept: (() => number)[] = [];
  list(item: () => number): number { return item() + item(); }
  read(key: string): number {
    switch (key) {
      case "a": return this.list(() => this.x);
      case "b": return this.list(() => this.y);
      case "c": return 7;
      case "d": { const f = () => this.x + this.y; this.kept.push(f); return f(); }
      default: return -1;
    }
  }
  loopy(n: number): number {
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i === 2) s += this.list(() => this.x * 10);
      if (i === 3) s += this.list(() => this.y * 100);
    }
    return s;
  }
  nested(flag: boolean): number {
    if (flag) return 0;
    const outer = () => { const inner = () => this.x + this.y; return inner() + this.x; };
    return outer();
  }
}
function plain(this: unknown, k: number): number {
  switch (k) {
    case 1: return (() => typeof this)().length;
    case 2: return [1, 2].map((): number => (this === undefined ? 1 : 0)).reduce((a, b) => a + b, 0);
    default: return -1;
  }
}
function main() {
  const r = new R();
  const out: unknown[] = [r.read("b"), r.read("a"), r.read("c"), r.read("z"), r.read("d"), r.kept.length, r.kept[0]()];
  out.push(r.loopy(0), r.loopy(3), r.loopy(5), r.nested(true), r.nested(false));
  out.push(plain.call(undefined, 2), plain.call(undefined, 1), plain.call(undefined, 3));
  console.log(JSON.stringify(out));
}
main();
