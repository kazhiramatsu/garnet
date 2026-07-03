function main(): void {
  const m = [[1, 2], [3, 4], [5, 6]];
  let s = 0;
  for (const row of m) for (const x of row) s += x;
  console.log(s);
  console.log(m.map(r => r[0] + r[1]).join(","));
  console.log(m.flat().join(","));
}

main();
