function main(): void {
  const a = JSON.parse("13") + JSON.parse("17") * 2;
  console.log(a);

  const b = (JSON.parse("5") << 2) | JSON.parse("3");
  console.log(b);

  console.log(Object.is(JSON.parse("-0"), -0));
}

main();
