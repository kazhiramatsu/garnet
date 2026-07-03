function main(): void {
  const a: any = [10, 20, 30];
  console.log(a.join(","));
  console.log(a.indexOf(20));
  console.log(a.includes(30));
  console.log(a.slice(1).join("-"));
  console.log(a.map((x: number) => x * 2).join(","));
  console.log(a.filter((x: number) => x > 15).length);
  const b: any = [1, 2, 3];
  b.custom = 99;
  console.log(b.custom, b[0], b.length);
}

main();
