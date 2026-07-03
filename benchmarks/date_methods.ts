function main(): void {
  const t1 = Date.now();
  const d = new Date();
  const t2 = d.getTime();
  console.log(t1 > 0 ? 1 : 0);       // 1
  console.log(t2 > 0 ? 1 : 0);       // 1
  console.log(d.valueOf() > 0 ? 1 : 0); // 1
}

main();
