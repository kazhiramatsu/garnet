function main(): void {
  const text = "{\"x\":1}";
  let value: any = JSON.parse(text);
  value = 5;
  console.log(value + 2);
}

main();
