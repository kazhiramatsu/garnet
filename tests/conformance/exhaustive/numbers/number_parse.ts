function main(): void {
  console.log(parseInt("42"), parseFloat("3.14"));
  console.log(Number("123"), +"99");
  console.log(isNaN(NaN), isFinite(42));
}

main();
