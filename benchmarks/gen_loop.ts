function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) {
    yield i;
  }
}
function main(): void {
  const g = range(4);
  console.log(g.next().value);  // 0
  console.log(g.next().value);  // 1
  console.log(g.next().value);  // 2
  console.log(g.next().value);  // 3
  console.log(g.next().done ? 1 : 0);  // 1
}

main();
