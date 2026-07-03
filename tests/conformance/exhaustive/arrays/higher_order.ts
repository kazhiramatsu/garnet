function main(): void {
  const a = [1, 2, 3, 4, 5, 6];
  console.log(a.map(x => x * x).join(","));
  console.log(a.filter(x => x % 2 === 0).join(","));
  console.log(a.reduce((s, x) => s + x, 0));
  console.log(a.find(x => x > 3), a.findIndex(x => x > 3));
  console.log(a.some(x => x > 5), a.every(x => x > 0));
}

main();
