let counter = 0;
function bump(): void { counter = counter + 1; }
function main(): void {
  bump();
  bump();
  bump();
  console.log(counter);
}
main();
