class Container<T> { item: T; constructor(x: T) { this.item = x; } load(): T { return this.item; } }
class NumCell extends Container<number> { constructor(n: number) { super(n); } twice(): number { return this.load() + this.load(); } }
class StrCell extends Container<string> { constructor(s: string) { super(s); } shout(): string { return this.load(); } }
function main(): void {
  const n = new NumCell(10);
  console.log(n.twice());      // 20
  const s = new StrCell("hi");
  console.log(s.shout());      // hi
  console.log(n.load());       // 10 (inherited method)
}

main();
