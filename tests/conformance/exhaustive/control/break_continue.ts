function main(): void {
  let s = 0;
  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) continue;
    if (i > 13) break;
    s += i;
  }
  console.log(s);
}

main();
