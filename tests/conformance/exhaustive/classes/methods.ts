class Stack {
  items: number[] = [];
  push(x: number): void { this.items.push(x); }
  pop(): number { return this.items.pop()!; }
  size(): number { return this.items.length; }
}
function main(): void {
  const s = new Stack();
  s.push(1); s.push(2); s.push(3);
  console.log(s.size(), s.pop(), s.size());
}

main();
