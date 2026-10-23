// A recursion of a couple of thousand frames (V8 takes about that many of
// these frames before its own limit) through methods that dispatch dynamically must
// complete: the program's main runs on a thread with a large stack, not the
// process's 8 MB one. Below V8's own limit, so both engines finish.
class Walker {
  count = 0;
  step(n: number, acc: string[], depth: number): number {
    const a = n * 2, b = n + depth, c = acc.length;
    if (n <= 0) return a + b + c;
    this.count++;
    if (depth % 1000 === 0) acc.push("d" + depth);
    return this.step(n - 1, acc, depth + 1) + (a - b + c) % 3;
  }
  describe(): string { return "walker"; }
}
class Deep extends Walker {
  step(n: number, acc: string[], depth: number): number { return super.step(n, acc, depth) + 1; }
}
// a prototype mutation keeps the classes dynamic
Walker.prototype.describe = function (this: Walker): string { return "patched:" + this.count; };
function main() {
  const w: Walker = new Deep();
  const acc: string[] = [];
  const r = w.step(2000, acc, 0);
  console.log(r, acc.join(","), w.describe(), w.count);
  const plain = (n: number): number => (n === 0 ? 0 : 1 + plain(n - 1));
  console.log(plain(2000));
}
main();
