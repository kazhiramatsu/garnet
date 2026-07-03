function main(): void {
  let count = 0;
  const inc = () => { count = count + 1; };
  inc(); inc(); inc();
  console.log(count);   // 3
}

main();
