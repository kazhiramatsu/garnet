function main(): void {
  console.log(parseInt("-0"), parseInt("-0.9"), parseInt("  -0  "), parseInt("-007"));
  console.log(Object.is(parseInt("-0"), -0), Object.is(parseInt("0"), -0), Object.is(parseInt("-5"), -5));
  console.log(parseInt("-10", 2), parseInt("-ff", 16));
}
main();
