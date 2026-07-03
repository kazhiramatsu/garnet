function main(): void {
  let a = 3.14159, b = 2.71828;
  console.log((a + b).toFixed(5), (a * b).toFixed(5), (a - b).toFixed(5));
  console.log(Math.sqrt(2).toFixed(6), Math.abs(-a).toFixed(5), Math.round(a * 100));
}

main();
