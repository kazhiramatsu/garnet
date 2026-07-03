function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}
function main(): void {
  let s = 0;
  for (const x of range(5)) s += x;
  console.log(s);
  const g = range(3);
  console.log(g.next().value, g.next().value, g.next().value, g.next().done);
}

main();
