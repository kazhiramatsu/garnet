function identity<T>(x: T): T { return x; }
function addOne<T>(x: number): number { return x + 1; }
function main(): void {
  const a = identity<number>(42);
  console.log(a + 8);          // 50
  const b = identity<number>(100);
  console.log(b);              // 100
}

main();
