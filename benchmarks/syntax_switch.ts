function classify(n: number): number {
  let r = 0;
  switch (n) {
    case 0: r = 100; break;
    case 1: r = 200; break;
    default: r = 999;
  }
  return r;
}
function countdown(n: number): number {
  let acc = 0;
  do { acc = acc + n; n = n - 1; } while (n > 0);
  return acc;
}
function main(): void {
  console.log(classify(1));   // 200
  console.log(countdown(5));  // 5+4+3+2+1 = 15
}

main();
