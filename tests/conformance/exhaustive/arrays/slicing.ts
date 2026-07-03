function main(): void {
  const a = [10, 20, 30, 40, 50];
  console.log(a.slice(1, 3).join(","), a.slice(-2).join(","));
  console.log(a.concat([60, 70]).join(","));
  console.log(a.indexOf(30), a.includes(40), a.at(-1));
}

main();
