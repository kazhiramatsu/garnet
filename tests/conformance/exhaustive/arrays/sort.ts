function main(): void {
  const a = [5, 2, 8, 1, 9, 3];
  console.log([...a].sort((x, y) => x - y).join(","));
  console.log([...a].sort((x, y) => y - x).join(","));
  const words = ["banana", "apple", "cherry"];
  console.log([...words].sort().join(","));
}

main();
