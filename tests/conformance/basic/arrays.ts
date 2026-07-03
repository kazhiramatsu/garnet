function main(): void {
  const a = [3, 1, 4, 1, 5, 9, 2, 6];
  console.log(a.length, a.filter(x => x > 3).map(x => x * 2).join(","));
  console.log(a.reduce((s, x) => s + x, 0), [...a].sort((x, y) => x - y).join(","));
}

main();
