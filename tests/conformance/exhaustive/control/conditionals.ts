function classify(n: number): string {
  if (n < 0) return "neg";
  else if (n === 0) return "zero";
  else if (n < 10) return "small";
  else return "big";
}
function main(): void {
  console.log(classify(-5), classify(0), classify(7), classify(100));
  const x = 5;
  console.log(x > 3 && x < 10, x < 0 || x > 4, !(x === 5));
}

main();
