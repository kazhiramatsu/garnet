class Box<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }
function main(): void {
  const bn = new Box<number>(42);
  const bs = new Box<string>("hi");
  console.log(bn.get());   // 42
  console.log(bs.get());   // hi
}

main();
