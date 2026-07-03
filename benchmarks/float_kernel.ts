function kernel(N: number): number {
  let acc = 0.0;
  let i = 0;
  while (i < N) {
    let x = i * 0.5;
    acc = acc + x * 1.000001 - x * 0.5;
    i = i + 1;
  }
  return acc;
}
function main(): void {
  console.log(kernel(100000000));
}

main();
