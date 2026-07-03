function makeCounter(): () => number {
  let count = 0;
  return () => ++count;
}
function main(): void {
  const c = makeCounter();
  console.log(c(), c(), c());
  const c2 = makeCounter();
  console.log(c2(), c());
}

main();
