function main(): void {
  const [a, b, c] = [1, 2, 3];
  console.log(a, b, c);
  const { x, y } = { x: 10, y: 20 };
  console.log(x, y);
  const [first, ...rest] = [1, 2, 3, 4];
  console.log(first, rest.join(","));
}

main();
