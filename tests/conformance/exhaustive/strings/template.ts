function main(): void {
  const name = "World", n = 42;
  console.log(`Hello ${name}, n=${n}, sum=${n + 8}`);
  console.log(`${n > 40 ? "big" : "small"} ${"x".repeat(n % 3)}`);
}

main();
