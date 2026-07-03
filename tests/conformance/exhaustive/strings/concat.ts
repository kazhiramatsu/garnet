function main(): void {
  let r = "";
  for (let i = 0; i < 5; i++) r += i + ",";
  console.log(r, "a" + 1 + 2, 1 + 2 + "a");
}

main();
